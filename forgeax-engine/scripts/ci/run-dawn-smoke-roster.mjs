import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPackages } from '../build-task-cache.mjs';

export const ROSTER_SCHEMA_VERSION = 2;
export const SHARD_COUNT = 4;
export const SMOKE_MIN_FRAMES = 300;
export const ENTRY_TIMEOUT_MS = 300_000;
export const RECEIPT_PREFIX = '[forgeax-smoke-receipt] ';
export const RECEIPT_PARSER_ID = 'forgeax-smoke-receipt-v1';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRosterPath = resolve(root, 'scripts/ci/dawn-smoke-roster.json');
const defaultReportsPath = resolve(root, 'artifacts/renderer-device-loss/smoke-roster');

function packagePaths(directory) {
  const result = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === 'package.json') result.push(path);
    }
  };
  walk(directory);
  return result.sort();
}

function entryKey(entry) {
  return `${entry.package}\n${entry.path}`;
}

function gateKey(entry) {
  return `${entry.gateId}\n${entry.commandId}`;
}

function pathWithinRoots(path, roots) {
  return roots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`));
}

function stable(value) {
  return JSON.stringify(value);
}

function rosterDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateRoster(roster, { roots = roster.roots } = {}) {
  if (roster?.schemaVersion !== ROSTER_SCHEMA_VERSION)
    throw new Error(`roster schemaVersion must be ${ROSTER_SCHEMA_VERSION}`);
  if (!Array.isArray(roster.roots) || roster.roots.length === 0)
    throw new Error('roster roots must be a non-empty array');
  if (stable(roster.roots) !== stable(roots)) throw new Error('roster roots drift');
  if (!Array.isArray(roster.entries)) throw new Error('roster entries must be an array');
  const keys = new Set();
  const packages = new Set();
  for (const entry of roster.entries) {
    if (!entry || typeof entry.package !== 'string' || typeof entry.path !== 'string')
      throw new Error('roster entry requires package and path');
    if (entry.classification !== 'supplemental' && !pathWithinRoots(entry.path, roots))
      throw new Error(`roster path outside roots: ${entry.path}`);
    if (!['run', 'excluded', 'supplemental'].includes(entry.classification))
      throw new Error(`invalid roster classification: ${entry.path}`);
    if (keys.has(entryKey(entry))) throw new Error(`duplicate roster entry: ${entry.path}`);
    if (packages.has(entry.package)) throw new Error(`duplicate roster package: ${entry.package}`);
    if ('command' in entry) throw new Error(`roster must not own command: ${entry.path}`);
    if (
      entry.classification === 'excluded' &&
      (typeof entry.reason !== 'string' || entry.reason.trim() === '')
    )
      throw new Error(`excluded entry needs reason: ${entry.path}`);
    if (entry.classification === 'run' && 'reason' in entry)
      throw new Error(`runnable entry must not carry exclusion reason: ${entry.path}`);
    if (!Array.isArray(entry.gates) || entry.gates.length === 0)
      throw new Error(`roster entry needs gate definitions: ${entry.path}`);
    const gateIds = new Set();
    for (const gate of entry.gates) {
      if (
        !gate ||
        typeof gate.gateId !== 'string' ||
        typeof gate.commandId !== 'string' ||
        typeof gate.executionClass !== 'string' ||
        typeof gate.commandSource !== 'string'
      )
        throw new Error(`invalid gate definition: ${entry.path}`);
      if (gateIds.has(gate.gateId)) throw new Error(`duplicate gate: ${gate.gateId}`);
      if (!['sharded', 'independent', 'excluded'].includes(gate.executionClass))
        throw new Error(`invalid gate execution class: ${gate.gateId}`);
      if (gate.commandSource === 'package-script' && typeof gate.script !== 'string')
        throw new Error(`package-script gate needs script: ${gate.gateId}`);
      if (!Array.isArray(gate.commands) || gate.commands.length === 0)
        throw new Error(`gate needs ordered commands: ${gate.gateId}`);
      if ('artifactRequirements' in gate) {
        const packGuids = gate.artifactRequirements?.packGuids;
        if (
          !Array.isArray(packGuids) ||
          packGuids.some(
            (guid) =>
              typeof guid !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid),
          ) ||
          new Set(packGuids).size !== packGuids.length
        )
          throw new Error(`invalid artifact requirements: ${gate.gateId}`);
      }
      const commandIds = new Set();
      for (const command of gate.commands) {
        if (!command || typeof command.commandId !== 'string')
          throw new Error(`invalid ordered command: ${gate.gateId}`);
        if (commandIds.has(command.commandId))
          throw new Error(`duplicate ordered command: ${gate.gateId}`);
        commandIds.add(command.commandId);
      }
      if (!commandIds.has(gate.commandId))
        throw new Error(`gate commandId is not in ordered commands: ${gate.gateId}`);
      if (!['frameReceipt', 'assertion', 'composite'].includes(gate.oracle?.kind))
        throw new Error(`invalid gate oracle: ${gate.gateId}`);
      if (gate.oracle.kind === 'frameReceipt' && gate.oracle.parserId !== RECEIPT_PARSER_ID)
        throw new Error(`frame gate parser drift: ${gate.gateId}`);
      gateIds.add(gate.gateId);
    }
    if (
      entry.classification === 'excluded' &&
      entry.gates.some((gate) => gate.executionClass !== 'excluded')
    )
      throw new Error(`excluded entry has runnable gate: ${entry.path}`);
    if (
      entry.classification !== 'excluded' &&
      entry.gates.some((gate) => gate.executionClass === 'excluded')
    )
      throw new Error(`runnable entry has excluded gate: ${entry.path}`);
    keys.add(entryKey(entry));
    packages.add(entry.package);
  }
  return roster;
}

export function readRoster(path = defaultRosterPath) {
  const roster = JSON.parse(readFileSync(path, 'utf8'));
  return validateRoster(roster);
}

export function discoverCandidates({
  repoRoot = root,
  roots = ['apps/hello', 'apps/learn-render'],
  supplementalEntries = [],
} = {}) {
  const candidates = [];
  for (const relativeRoot of roots) {
    const absoluteRoot = resolve(repoRoot, relativeRoot);
    if (!existsSync(absoluteRoot)) throw new Error(`smoke root missing: ${relativeRoot}`);
    for (const path of packagePaths(absoluteRoot)) {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (!Object.hasOwn(pkg?.forgeax ?? {}, 'smokeInvocation')) continue;
      candidates.push({
        package: pkg.name,
        path: relative(repoRoot, path),
      });
    }
  }
  for (const entry of supplementalEntries) {
    const path = resolve(repoRoot, entry.path);
    if (!existsSync(path)) throw new Error(`supplemental smoke manifest missing: ${entry.path}`);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (!Object.hasOwn(pkg?.forgeax ?? {}, 'smokeInvocation')) continue;
    candidates.push({ package: pkg.name, path: relative(repoRoot, path) });
  }
  const keys = new Set();
  for (const candidate of candidates) {
    if (keys.has(entryKey(candidate)))
      throw new Error(`duplicate manifest candidate: ${candidate.path}`);
    keys.add(entryKey(candidate));
  }
  return candidates.sort(
    (a, b) => a.package.localeCompare(b.package) || a.path.localeCompare(b.path),
  );
}

export function resolveRunnableEntries({ repoRoot = root, roster, roots = roster.roots } = {}) {
  validateRoster(roster, { roots });
  const supplementalEntries = roster.entries.filter(
    (entry) => entry.classification === 'supplemental',
  );
  const candidates = discoverCandidates({ repoRoot, roots, supplementalEntries });
  const candidateKeys = new Set(candidates.map(entryKey));
  const rosterKeys = new Set(roster.entries.map(entryKey));
  const missing = [...candidateKeys].filter((key) => !rosterKeys.has(key));
  const extra = [...rosterKeys].filter((key) => !candidateKeys.has(key));
  if (missing.length || extra.length) {
    throw new Error(
      `roster membership drift: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`,
    );
  }
  const manifests = new Map(candidates.map((candidate) => [entryKey(candidate), candidate]));
  const runnable = [];
  const independent = [];
  const exclusions = [];
  const declaredGateIds = [];
  const runnableGateIds = [];
  const independentGateIds = [];
  const excludedGateIds = [];
  for (const entry of roster.entries) {
    const candidate = manifests.get(entryKey(entry));
    if (!candidate) throw new Error(`roster candidate missing: ${entry.path}`);
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, candidate.path), 'utf8'));
    const manifestCommand = manifest?.forgeax?.smokeInvocation;
    const executableGates = entry.gates.filter((gate) => gate.executionClass !== 'excluded');
    if (
      executableGates.length > 0 &&
      (typeof manifestCommand !== 'string' || manifestCommand.trim() === '')
    )
      throw new Error(`runnable manifest command missing: ${entry.path}`);
    for (const gate of entry.gates) {
      declaredGateIds.push(gate.gateId);
      const command =
        gate.commandSource === 'manifest-smokeInvocation'
          ? (manifestCommand ?? '').trim()
          : `pnpm --filter ${entry.package} ${gate.script}`;
      const resolvedGate = {
        package: entry.package,
        path: entry.path,
        classification: entry.classification,
        gateId: gate.gateId,
        commandId: gate.commandId,
        executionClass: gate.executionClass,
        command,
      };
      if (gate.executionClass === 'sharded') {
        runnable.push(resolvedGate);
        runnableGateIds.push(gate.gateId);
      } else if (gate.executionClass === 'independent') {
        independent.push(resolvedGate);
        independentGateIds.push(gate.gateId);
      } else {
        excludedGateIds.push(gate.gateId);
      }
    }
    if (entry.classification === 'excluded') exclusions.push({ ...entry });
  }
  const sortEntries = (a, b) =>
    a.package.localeCompare(b.package) ||
    a.path.localeCompare(b.path) ||
    a.gateId.localeCompare(b.gateId) ||
    a.commandId.localeCompare(b.commandId);
  runnable.sort(sortEntries);
  independent.sort(sortEntries);
  return {
    declared: roster.entries.map((entry) => ({ ...entry })),
    runnable,
    independent,
    exclusions,
    declaredGateIds,
    runnableGateIds,
    independentGateIds,
    excludedGateIds,
  };
}

export function partitionRunnableEntries(entries, { shardIndex, shardCount = SHARD_COUNT } = {}) {
  if (!Number.isInteger(shardCount) || shardCount < 1)
    throw new Error(`invalid shardCount: ${shardCount}`);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount)
    throw new Error(`invalid shardIndex: ${shardIndex}`);
  return [...entries]
    .sort(
      (a, b) =>
        a.package.localeCompare(b.package) ||
        a.path.localeCompare(b.path) ||
        a.gateId.localeCompare(b.gateId) ||
        a.commandId.localeCompare(b.commandId),
    )
    .filter((_, index) => index % shardCount === shardIndex);
}

export function validateShardReport(report) {
  if (report?.schemaVersion !== ROSTER_SCHEMA_VERSION || report.kind !== 'dawn-smoke-shard')
    throw new Error('invalid Dawn shard report schema');
  if (!/^[0-9a-f]{40}$/.test(report.head))
    throw new Error('shard report requires a full actual head');
  if (!/^[0-9a-f]{40}$/.test(report.expectedProductSha))
    throw new Error('shard report requires a full expectedProductSha');
  if (!/^[0-9a-f]{64}$/.test(report.rosterDigest))
    throw new Error('shard report requires a roster digest');
  if (!Number.isInteger(report.shardIndex) || !Number.isInteger(report.shardCount))
    throw new Error('shard report needs shard index/count');
  if (report.shardCount < 1 || report.shardIndex < 0 || report.shardIndex >= report.shardCount)
    throw new Error('invalid shard report index/count');
  if (report.framesExpected !== SMOKE_MIN_FRAMES)
    throw new Error(`shard framesExpected must be ${SMOKE_MIN_FRAMES}`);
  for (const field of [
    'declaredGateIds',
    'runnableGateIds',
    'excludedGateIds',
    'assignedGateIds',
    'declaredEntries',
    'runnableEntries',
    'exclusions',
    'assignedEntries',
  ]) {
    if (!Array.isArray(report[field])) throw new Error(`shard report requires ${field}`);
  }
  const declaredGateIds = requireUniqueStrings(report.declaredGateIds, 'declaredGateIds');
  const runnableGateIds = requireUniqueStrings(report.runnableGateIds, 'runnableGateIds');
  const independentGateIds = requireUniqueStrings(
    report.independentGateIds ?? [],
    'independentGateIds',
  );
  const excludedGateIds = requireUniqueStrings(report.excludedGateIds, 'excludedGateIds');
  const assignedGateIds = requireUniqueStrings(report.assignedGateIds, 'assignedGateIds');
  const declared = new Set(declaredGateIds);
  const runnable = new Set(runnableGateIds);
  const independent = new Set(independentGateIds);
  const excluded = new Set(excludedGateIds);
  const assigned = new Set(assignedGateIds);
  if (!isUnionOf(runnable, independent, excluded, declared))
    throw new Error('declared gate closure drift');
  if (![...assigned].every((gateId) => runnable.has(gateId)))
    throw new Error('assigned gate is outside runnable closure');
  const assignedEntryKeys = new Set();
  for (const entry of report.assignedEntries) {
    if (typeof entry?.gateId !== 'string' || typeof entry.commandId !== 'string')
      throw new Error('assigned entry requires gateId and commandId');
    const key = gateKey(entry);
    if (assignedEntryKeys.has(key)) throw new Error(`duplicate assigned entry: ${key}`);
    if (!assigned.has(entry.gateId)) throw new Error(`assigned entry outside gate closure: ${key}`);
    assignedEntryKeys.add(key);
  }
  const keys = new Set();
  for (const result of report.runnableEntries) {
    if (typeof result?.package !== 'string' || typeof result.path !== 'string')
      throw new Error('shard result requires package and path');
    if (typeof result.gateId !== 'string' || typeof result.commandId !== 'string')
      throw new Error('shard result requires gateId and commandId');
    const key = gateKey(result);
    if (keys.has(key)) throw new Error(`duplicate shard result: ${result.path}`);
    if (result.shardIndex !== report.shardIndex)
      throw new Error(`shard result index drift: ${result.path}`);
    if (!runnable.has(result.gateId)) throw new Error(`result outside runnable closure: ${key}`);
    if (typeof result.command !== 'string' || result.command.trim() === '')
      throw new Error(`missing command: ${key}`);
    if (!Number.isInteger(result.exitCode) && result.exitCode !== null)
      throw new Error(`invalid exitCode: ${key}`);
    if (result.signal !== null && typeof result.signal !== 'string')
      throw new Error(`invalid signal: ${key}`);
    for (const field of ['timedOut', 'unavailable', 'skipped', 'unavailableOrSkipped']) {
      if (typeof result[field] !== 'boolean') throw new Error(`missing ${field}: ${key}`);
    }
    if (!Number.isInteger(result.framesExpected) || result.framesExpected !== SMOKE_MIN_FRAMES)
      throw new Error(`shard result frame expectation drift: ${result.path}`);
    if (result.framesObserved !== null && !Number.isInteger(result.framesObserved))
      throw new Error(`invalid frame evidence: ${result.path}`);
    if (!['pass', 'fail', 'blocked'].includes(result.status))
      throw new Error(`unknown result status: ${key}`);
    if (!['pass', 'fail', 'blocked'].includes(result.result))
      throw new Error(`unknown result token: ${key}`);
    if (result.failureReason !== null && typeof result.failureReason !== 'string')
      throw new Error(`invalid failureReason: ${key}`);
    if (typeof result.logPath !== 'string' || result.logPath.trim() === '')
      throw new Error(`missing logPath: ${key}`);
    if (!/^[0-9a-f]{64}$/.test(result.logSha256)) throw new Error(`missing logSha256: ${key}`);
    if (!Number.isInteger(result.logBytes) || result.logBytes < 0)
      throw new Error(`invalid logBytes: ${key}`);
    if (!Array.isArray(result.commandResults) || result.commandResults.length === 0)
      throw new Error(`missing commandResults: ${key}`);
    if (!('receipt' in result)) throw new Error(`missing receipt field: ${key}`);
    if (result.receipt !== null) {
      if (typeof result.receipt !== 'object') throw new Error(`invalid receipt: ${key}`);
      validateObservedReceipt(result.receipt, {
        gateId: result.gateId,
        commandId: result.commandId,
      });
      if (result.receipt.framesObserved !== result.framesObserved)
        throw new Error(`receipt frame mismatch: ${key}`);
    }
    if (result.status === 'blocked') {
      if (result.result !== 'blocked') throw new Error(`blocked result token drift: ${key}`);
      if (result.framesObserved !== null || result.receipt !== null)
        throw new Error(`blocked result carries frame evidence: ${key}`);
      if (result.failureReason === null)
        throw new Error(`blocked result requires a failureReason: ${key}`);
    }
    if (result.status === 'pass' && result.receipt === null)
      throw new Error(`passing result requires receipt: ${key}`);
    if (result.status === 'pass' && result.framesObserved < SMOKE_MIN_FRAMES)
      throw new Error(`passing result has short frame evidence: ${key}`);
    keys.add(key);
  }
  if (stable(report.runnableEntries.map(gateKey).sort()) !== stable([...assignedEntryKeys].sort()))
    throw new Error('assigned result closure drift');
  if (
    stable([...assigned].sort()) !==
    stable(report.assignedEntries.map((entry) => entry.gateId).sort())
  )
    throw new Error('assigned gate ledger drift');
  return report;
}

function requireUniqueStrings(value, field) {
  if (!value.every((item) => typeof item === 'string' && item.length > 0))
    throw new Error(`${field} contains an invalid token`);
  const unique = new Set(value);
  if (unique.size !== value.length) throw new Error(`${field} contains duplicate tokens`);
  return value;
}

function isUnionOf(runnable, independent, excluded, declared) {
  if (
    [...runnable].some((gateId) => independent.has(gateId) || excluded.has(gateId)) ||
    [...independent].some((gateId) => excluded.has(gateId))
  )
    return false;
  const union = new Set([...runnable, ...independent, ...excluded]);
  return union.size === declared.size && [...union].every((gateId) => declared.has(gateId));
}

function validateObservedReceipt(receipt, identity) {
  const required = [
    'schemaVersion',
    'gateId',
    'commandId',
    'framesObserved',
    'completed',
    'rawLine',
    'rawLineSha256',
    'parserId',
  ];
  for (const field of required) {
    if (!(field in receipt)) throw new Error(`receipt requires ${field}`);
  }
  if (receipt.schemaVersion !== 1 || receipt.gateId !== identity.gateId)
    throw new Error('receipt gate identity drift');
  if (receipt.commandId !== identity.commandId) throw new Error('receipt command identity drift');
  if ('framesExpected' in receipt) throw new Error('receipt must not contain framesExpected');
  if (!Number.isInteger(receipt.framesObserved) || receipt.framesObserved < SMOKE_MIN_FRAMES)
    throw new Error('receipt framesObserved is below the required minimum');
  if (receipt.completed !== true) throw new Error('receipt is not completed');
  if (typeof receipt.rawLine !== 'string' || !receipt.rawLine.startsWith(RECEIPT_PREFIX))
    throw new Error('receipt rawLine is not canonical');
  if (!/^[0-9a-f]{64}$/.test(receipt.rawLineSha256)) throw new Error('receipt digest is invalid');
  if (receipt.parserId !== RECEIPT_PARSER_ID) throw new Error('receipt parser is unknown');
  return receipt;
}

export function parseObservedFrameReceipt(output, { gateId, commandId } = {}) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (lines.length !== 1)
    throw new Error(`expected exactly one observed receipt, found ${lines.length}`);
  const rawLine = lines[0];
  let payload;
  try {
    payload = JSON.parse(rawLine.slice(RECEIPT_PREFIX.length));
  } catch (error) {
    throw new Error(`receipt JSON is invalid: ${error.message}`);
  }
  const receipt = {
    ...payload,
    rawLine,
    rawLineSha256: createHash('sha256').update(rawLine).digest('hex'),
    parserId: RECEIPT_PARSER_ID,
  };
  return validateObservedReceipt(receipt, { gateId, commandId });
}

function hasCanonicalReceiptLine(output) {
  return String(output)
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(RECEIPT_PREFIX));
}

function readHead(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function hasUnavailableOrSkipped(output) {
  return /\b(?:unavailable|skipped?|skip)\b/i.test(output);
}

function runCommand(command, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd: root,
      detached: true,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      child.stdout.destroy();
      child.stderr.destroy();
      resolveResult({ exitCode, signal, output, timedOut });
    });
  });
}

function writeReport(report, reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function validateLogFiles(report, reportDirectory) {
  if (!reportDirectory) return;
  for (const result of report.runnableEntries) {
    const logPath = resolve(reportDirectory, result.logPath);
    const relativePath = relative(resolve(reportDirectory), logPath);
    if (relativePath.startsWith('..') || relativePath.includes('/..'))
      throw new Error(`log path escapes report directory: ${result.gateId}`);
    if (!existsSync(logPath)) throw new Error(`missing log file: ${result.logPath}`);
    const content = readFileSync(logPath);
    if (content.byteLength !== result.logBytes) throw new Error(`log byte drift: ${result.gateId}`);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== result.logSha256) throw new Error(`log digest drift: ${result.gateId}`);
  }
}

export function buildShardReport({
  resolved,
  assigned,
  head,
  expectedProductSha,
  rosterDigest: digest,
  shardIndex,
  shardCount = SHARD_COUNT,
  results,
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('shard report needs a full actual head');
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha))
    throw new Error('shard report needs a full expectedProductSha');
  const declaredGateIds =
    resolved.declaredGateIds ?? resolved.declared.map((entry) => entry.gateId);
  const runnableGateIds =
    resolved.runnableGateIds ?? resolved.runnable.map((entry) => entry.gateId);
  const independentGateIds =
    resolved.independentGateIds ?? resolved.independent?.map((entry) => entry.gateId) ?? [];
  const excludedGateIds =
    resolved.excludedGateIds ?? resolved.exclusions.map((entry) => entry.gateId);
  if (
    ![...declaredGateIds, ...runnableGateIds, ...excludedGateIds].every(
      (id) => typeof id === 'string',
    )
  )
    throw new Error('gate-level roster is required for shard reports');
  return {
    schemaVersion: ROSTER_SCHEMA_VERSION,
    kind: 'dawn-smoke-shard',
    head,
    expectedProductSha,
    rosterDigest: digest,
    shardIndex,
    shardCount,
    framesExpected: SMOKE_MIN_FRAMES,
    declaredGateIds,
    runnableGateIds,
    independentGateIds,
    excludedGateIds,
    assignedGateIds: [...new Set(assigned.map((entry) => entry.gateId))],
    declaredEntries: resolved.declared,
    runnableEntries: results.map((result) => ({ ...result })),
    exclusions: resolved.exclusions,
    assignedEntries: assigned.map(({ gateId, commandId }) => ({
      gateId,
      commandId,
    })),
  };
}

export function aggregateReports({
  reports,
  resolved,
  head,
  expectedProductSha,
  rosterDigest: digest,
  reportDirectory,
  shardCount = SHARD_COUNT,
  allowBlocked = false,
} = {}) {
  if (!Array.isArray(reports) || reports.length !== shardCount)
    throw new Error(`missing shard report: expected ${shardCount}`);
  const declaredGateIds =
    resolved.declaredGateIds ?? resolved.declared?.map((entry) => entry.gateId);
  const runnableGateIds =
    resolved.runnableGateIds ?? resolved.runnable?.map((entry) => entry.gateId);
  const independentGateIds =
    resolved.independentGateIds ?? resolved.independent?.map((entry) => entry.gateId) ?? [];
  const excludedGateIds =
    resolved.excludedGateIds ?? resolved.exclusions?.map((entry) => entry.gateId);
  if (
    !Array.isArray(declaredGateIds) ||
    !Array.isArray(runnableGateIds) ||
    !Array.isArray(excludedGateIds)
  )
    throw new Error('gate-level resolved roster is required for aggregation');
  const expectedRunnable = resolved.runnableGates ?? resolved.runnable;
  const expectedDeclared = resolved.declared ?? [];
  const expectedExclusions = resolved.exclusions ?? [];
  if (!Array.isArray(expectedRunnable)) throw new Error('resolved runnable gates are required');
  const byIndex = new Map();
  for (const report of reports) {
    validateShardReport(report);
    validateLogFiles(report, reportDirectory);
    if (report.shardCount !== shardCount) throw new Error('shard count drift');
    if (byIndex.has(report.shardIndex)) throw new Error(`duplicate shard: ${report.shardIndex}`);
    if (report.head !== head) throw new Error(`head drift in shard ${report.shardIndex}`);
    if (expectedProductSha !== undefined && report.expectedProductSha !== expectedProductSha)
      throw new Error(`expected product sha drift in shard ${report.shardIndex}`);
    if (report.rosterDigest !== digest)
      throw new Error(`roster digest drift in shard ${report.shardIndex}`);
    if (stable(report.declaredGateIds) !== stable(declaredGateIds))
      throw new Error(`declared gate set drift in shard ${report.shardIndex}`);
    if (stable(report.runnableGateIds) !== stable(runnableGateIds))
      throw new Error(`runnable gate set drift in shard ${report.shardIndex}`);
    if (stable(report.independentGateIds ?? []) !== stable(independentGateIds))
      throw new Error(`independent gate set drift in shard ${report.shardIndex}`);
    if (stable(report.excludedGateIds) !== stable(excludedGateIds))
      throw new Error(`excluded gate set drift in shard ${report.shardIndex}`);
    if (stable(report.declaredEntries) !== stable(expectedDeclared))
      throw new Error(`declared set drift in shard ${report.shardIndex}`);
    if (stable(report.exclusions) !== stable(expectedExclusions))
      throw new Error(`exclusion set drift in shard ${report.shardIndex}`);
    byIndex.set(report.shardIndex, report);
  }
  for (let index = 0; index < shardCount; index += 1)
    if (!byIndex.has(index)) throw new Error(`missing shard: ${index}`);

  const expectedByKey = new Map(expectedRunnable.map((entry) => [gateKey(entry), entry]));
  const assignedByKey = new Map();
  const results = [];
  for (let index = 0; index < shardCount; index += 1) {
    const expected = partitionRunnableEntries(expectedRunnable, { shardIndex: index, shardCount });
    for (const entry of expected) assignedByKey.set(gateKey(entry), index);
    const report = byIndex.get(index);
    const expectedKeys = new Set(expected.map(gateKey));
    const actualKeys = new Set(report.runnableEntries.map(gateKey));
    for (const key of expectedKeys)
      if (!actualKeys.has(key)) throw new Error(`missing entry: ${key}`);
    for (const key of actualKeys)
      if (!expectedKeys.has(key)) throw new Error(`extra entry: ${key}`);
    for (const result of report.runnableEntries) {
      const key = gateKey(result);
      if (!expectedByKey.has(key)) throw new Error(`extra runnable entry: ${key}`);
      if (result.command !== expectedByKey.get(key).command)
        throw new Error(`command drift: ${key}`);
      if (result.exitCode !== 0 || result.signal !== null) throw new Error(`entry failure: ${key}`);
      if (result.unavailableOrSkipped === true)
        throw new Error(`entry unavailable or skipped: ${key}`);
      if (result.status === 'blocked' || result.result === 'blocked') {
        if (!allowBlocked) throw new Error(`entry is blocked: ${key}`);
        if (result.receipt !== null) throw new Error(`blocked entry has observed receipt: ${key}`);
        results.push(result);
        continue;
      }
      if (result.status !== 'pass' || result.result !== 'pass')
        throw new Error(`entry result is not pass: ${key}`);
      if (result.receipt === null) throw new Error(`entry is missing observed receipt: ${key}`);
      if (result.framesObserved < SMOKE_MIN_FRAMES) throw new Error(`short frame evidence: ${key}`);
      results.push(result);
    }
  }
  if (
    results.length !== expectedByKey.size ||
    new Set(results.map(gateKey)).size !== results.length
  )
    throw new Error('duplicate or missing runnable coverage');
  const expectedAssigned = [...assignedByKey].map(([key, shardIndex]) => ({ key, shardIndex }));
  const actualAssigned = reports
    .flatMap((report) =>
      report.assignedEntries.map(({ gateId, commandId }) => ({
        key: gateKey({ gateId, commandId }),
        shardIndex: report.shardIndex,
      })),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  if (
    stable(actualAssigned) !== stable(expectedAssigned.sort((a, b) => a.key.localeCompare(b.key)))
  )
    throw new Error('complete shard ledger drift');
  return {
    schemaVersion: ROSTER_SCHEMA_VERSION,
    kind: 'dawn-smoke-aggregate',
    status: results.some((result) => result.status === 'blocked') ? 'blocked' : 'pass',
    head,
    expectedProductSha: expectedProductSha ?? reports[0].expectedProductSha,
    rosterDigest: digest,
    shardCount,
    framesExpected: SMOKE_MIN_FRAMES,
    declaredGateIds,
    runnableGateIds,
    excludedGateIds,
    declaredEntries: expectedDeclared,
    runnableResults: results,
    exclusions: expectedExclusions,
    assignedEntries: expectedAssigned,
  };
}

export function preflightRunEntries(
  entries,
  { repoRoot = root, buildGraph = appPackages(repoRoot) } = {},
) {
  const builtDirectories = new Set(
    buildGraph.map((app) => resolve(repoRoot, app.relativeDirectory ?? app.directory)),
  );
  const failures = [];
  for (const entry of entries) {
    const packageDirectory = resolve(repoRoot, dirname(entry.path));
    if (!builtDirectories.has(packageDirectory))
      failures.push(`${entry.path}: missing canonical app build graph entry`);
    const shaderManifest = resolve(packageDirectory, 'dist', 'shaders', 'manifest.json');
    if (!existsSync(shaderManifest)) failures.push(`${entry.path}: missing ${shaderManifest}`);
  }
  if (failures.length > 0) throw new Error(`Dawn smoke preflight failed:\n${failures.join('\n')}`);
  return entries;
}

export function checkRoster({ rosterPath = defaultRosterPath, roots } = {}) {
  const roster = readRoster(rosterPath);
  const selectedRoots = roots ?? roster.roots;
  const resolved = resolveRunnableEntries({ repoRoot: root, roster, roots: selectedRoots });
  process.stdout.write(
    `[dawn-roster] check pass declared=${resolved.declared.length} runnable=${resolved.runnable.length} exclusions=${resolved.exclusions.length}\n`,
  );
  return { roster, resolved, rosterDigest: rosterDigest(rosterPath) };
}

function resultStatus(result, observed, unavailableOrSkipped) {
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    observed !== null &&
    observed >= SMOKE_MIN_FRAMES
  )
    return 'pass';
  // A zero-exit smoke that has no canonical producer receipt is an explicit
  // evidence gap, not a passing frame gate. The caller may carry this as
  // BLOCKED only when the invocation explicitly opts into the authorized
  // defer path; the default CLI remains fail-closed.
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    observed === null &&
    !hasCanonicalReceiptLine(result.output)
  )
    return 'blocked';
  return 'fail';
}

function resultFailureReason(result, observed, unavailableOrSkipped) {
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    observed !== null &&
    observed >= SMOKE_MIN_FRAMES
  )
    return null;
  if (result.timedOut) return 'timeout';
  if (observed === null)
    return hasCanonicalReceiptLine(result.output)
      ? 'invalid-frame-evidence'
      : 'missing-frame-evidence';
  if (observed < SMOKE_MIN_FRAMES) return 'short-frame-evidence';
  if (unavailableOrSkipped) return 'unavailable-or-skipped';
  return `exit-${result.exitCode ?? result.signal}`;
}

async function runEntry({ entry, shardIndex, reportPath, timeoutMs }) {
  process.stdout.write(`[dawn-roster] run ${entry.package}: ${entry.command}\n`);
  const result = await runCommand(
    entry.command,
    { ...process.env, SMOKE_MIN_FRAMES: String(SMOKE_MIN_FRAMES) },
    timeoutMs,
  );
  let receipt = null;
  let receiptFailure = null;
  try {
    receipt = parseObservedFrameReceipt(result.output, {
      gateId: entry.gateId,
      commandId: entry.commandId,
    });
  } catch (error) {
    receiptFailure = error.message;
  }
  const observed = receipt?.framesObserved ?? null;
  const unavailableOrSkipped = hasUnavailableOrSkipped(result.output);
  const status = resultStatus(result, observed, unavailableOrSkipped);
  const logPath = resolve(dirname(reportPath), 'logs', `${entry.package.replaceAll('/', '_')}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  const logBytes = Buffer.byteLength(result.output);
  const logSha256 = createHash('sha256').update(result.output).digest('hex');
  return {
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId,
    commandId: entry.commandId,
    shardIndex,
    command: entry.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    unavailable: unavailableOrSkipped && /\bunavailable\b/i.test(result.output),
    skipped: unavailableOrSkipped && /\bskip(?:ped)?\b/i.test(result.output),
    framesObserved: observed,
    framesExpected: SMOKE_MIN_FRAMES,
    status,
    result: status,
    unavailableOrSkipped,
    logPath: relative(dirname(reportPath), logPath),
    logSha256,
    logBytes,
    receipt,
    commandResults: [
      {
        commandId: entry.commandId,
        command: entry.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        status,
      },
    ],
    failureReason: resultFailureReason(result, observed, unavailableOrSkipped) ?? receiptFailure,
  };
}

export async function runShard({
  rosterPath = defaultRosterPath,
  reportPath = resolve(defaultReportsPath, 'shard.json'),
  roots,
  shardIndex,
  shardCount = SHARD_COUNT,
  expectedProductSha = process.env.EXPECTED_PRODUCT_SHA,
  timeoutMs = Number(process.env.DAWN_SMOKE_ENTRY_TIMEOUT_MS ?? ENTRY_TIMEOUT_MS),
  allowBlocked = false,
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha ?? ''))
    throw new Error('run requires a full external expectedProductSha');
  const actualHead = readHead(root);
  if (actualHead !== expectedProductSha)
    throw new Error(`checked-out product head ${actualHead} does not match expectedProductSha`);
  const { resolved, rosterDigest: digest } = checkRoster({ rosterPath, roots });
  preflightRunEntries(resolved.runnable);
  const assigned = partitionRunnableEntries(resolved.runnable, { shardIndex, shardCount });
  const results = [];
  for (const entry of assigned) {
    results.push(await runEntry({ entry, shardIndex, reportPath, timeoutMs }));
  }
  const report = buildShardReport({
    resolved,
    assigned,
    head: actualHead,
    expectedProductSha,
    rosterDigest: digest,
    shardIndex,
    shardCount,
    results,
  });
  validateShardReport(report);
  writeReport(report, reportPath);
  if (
    results.some(
      (result) => result.status === 'fail' || (result.status === 'blocked' && !allowBlocked),
    )
  )
    throw new Error('Dawn smoke shard failed');
  return report;
}

export function readReports(reportDirectory, shardCount = SHARD_COUNT) {
  return Array.from({ length: shardCount }, (_, index) => {
    const path = resolve(reportDirectory, `shard-${index}.json`);
    if (!existsSync(path)) throw new Error(`missing shard report: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  });
}

export function runAggregate({
  rosterPath = defaultRosterPath,
  reportDirectory = defaultReportsPath,
  roots,
  shardCount = SHARD_COUNT,
  expectedProductSha = process.env.EXPECTED_PRODUCT_SHA,
  allowBlocked = false,
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha ?? ''))
    throw new Error('aggregate requires a full external expectedProductSha');
  const actualHead = readHead(root);
  if (actualHead !== expectedProductSha)
    throw new Error(`checked-out product head ${actualHead} does not match expectedProductSha`);
  const { resolved, rosterDigest: digest } = checkRoster({ rosterPath, roots });
  const aggregate = aggregateReports({
    reports: readReports(reportDirectory, shardCount),
    resolved,
    head: actualHead,
    expectedProductSha,
    rosterDigest: digest,
    reportDirectory,
    shardCount,
    allowBlocked,
  });
  writeReport(aggregate, resolve(reportDirectory, 'aggregate.json'));
  process.stdout.write(
    `[dawn-roster] aggregate ${aggregate.status} runnable=${aggregate.runnableResults.length} exclusions=${aggregate.exclusions.length}\n`,
  );
  return aggregate;
}

export function parseCli(argv) {
  const options = { mode: '--check', roots: undefined, shardCount: SHARD_COUNT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--run' || arg === '--aggregate') options.mode = arg;
    else if (arg === '--manifest') options.rosterPath = resolve(root, argv[++index]);
    else if (arg === '--report') options.reportPath = resolve(root, argv[++index]);
    else if (arg === '--reports') options.reportDirectory = resolve(root, argv[++index]);
    else if (arg === '--expected-product-sha') options.expectedProductSha = argv[++index];
    else if (arg === '--shard-index') options.shardIndex = Number(argv[++index]);
    else if (arg === '--shard-count') options.shardCount = Number(argv[++index]);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--allow-blocked') options.allowBlocked = true;
    else if (arg === '--roots') {
      options.roots = [];
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--'))
        options.roots.push(argv[++index]);
      if (options.roots.length === 0) throw new Error('--roots requires at least one directory');
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.mode === '--check') checkRoster(options);
    else if (options.mode === '--run') {
      if (options.shardIndex === undefined) throw new Error('--run requires --shard-index');
      await runShard(options);
    } else runAggregate(options);
  } catch (error) {
    console.error(`[dawn-roster] ${error.message}`);
    process.exitCode = 1;
  }
}
