import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { createOwnedProcessGroupStopper } from '../../../apps/shared/scripts/rhi-debug-process.mjs';

const CHILD_SCRIPT = `
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const role = process.argv[1];
  const port = Number(process.argv[2]);
  const ignoreTerm = process.argv[3] === 'ignore-term';
  if (role === 'parent') {
    const worker = spawn(process.execPath, ['-e', process.env.FORGEAX_CHILD_SCRIPT, 'worker', String(port), process.argv[3]], {
      stdio: 'ignore',
    });
    if (ignoreTerm) process.on('SIGTERM', () => {});
    else process.on('SIGTERM', () => { worker.kill('SIGTERM'); process.exit(0); });
    setInterval(() => {}, 1000);
  } else {
    const server = net.createServer((socket) => socket.end('ok'));
    server.listen(port, '127.0.0.1');
    if (ignoreTerm) process.on('SIGTERM', () => {});
    else process.on('SIGTERM', () => server.close(() => process.exit(0)));
    setInterval(() => {}, 1000);
  }
`;

function freePort(excluded = new Set()) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else if (excluded.has(port)) {
          freePort(excluded).then(resolve, reject);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`port ${port} did not become ready`);
}

async function assertPortCanBind(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function spawnFixture(port, mode = 'term') {
  const child = spawn(
    process.execPath,
    ['-e', CHILD_SCRIPT, 'parent', String(port), mode === 'kill' ? 'ignore-term' : ''],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FORGEAX_CHILD_SCRIPT: CHILD_SCRIPT },
    },
  );
  return child;
}

async function stopAndRebind(stop, options) {
  await waitForPort(options.port);
  const [first, second] = await Promise.all([stop(), stop()]);
  assert.deepEqual(first, second);
  assert.deepEqual(await stop(), first);
  await assertPortCanBind(options.port);
  return first;
}

test('owned process group cleanup handles TERM, KILL fallback, and idempotency', {
  skip: process.platform === 'win32',
}, async () => {
  const termPort = await freePort();
  const termChild = spawnFixture(termPort);
  const stopTerm = createOwnedProcessGroupStopper(termChild, { graceMs: 300, pollMs: 10 });
  try {
    assert.deepEqual(await stopAndRebind(stopTerm, { port: termPort }), {
      kind: 'sigterm',
    });
  } finally {
    await stopTerm();
  }

  const killPort = await freePort();
  const killChild = spawnFixture(killPort, 'kill');
  const stopKill = createOwnedProcessGroupStopper(killChild, { graceMs: 150, pollMs: 10 });
  try {
    assert.deepEqual(await stopAndRebind(stopKill, { port: killPort }), {
      kind: 'sigkill',
    });
  } finally {
    await stopKill();
  }
});

test('owned cleanup does not signal a foreign process group', {
  skip: process.platform === 'win32',
}, async () => {
  const ownedPort = await freePort();
  const foreignPort = await freePort(new Set([ownedPort]));
  const owned = spawnFixture(ownedPort);
  const foreign = spawnFixture(foreignPort, 'kill');
  const stopOwned = createOwnedProcessGroupStopper(owned, { graceMs: 300, pollMs: 10 });
  const stopForeign = createOwnedProcessGroupStopper(foreign, { graceMs: 300, pollMs: 10 });
  try {
    await waitForPort(ownedPort);
    await waitForPort(foreignPort);
    await stopOwned();
    assert.doesNotThrow(() => process.kill(foreign.pid, 0));
    await assertPortCanBind(ownedPort);
    assert.throws(
      () => createOwnedProcessGroupStopper({ pid: 1 }),
      /invalid owned process-group leader pid/,
    );
  } finally {
    await stopOwned();
    await stopForeign();
  }
});
