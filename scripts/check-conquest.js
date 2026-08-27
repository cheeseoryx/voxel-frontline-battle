/* Deterministic data-level checks for conquest rules, squads and networking. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

function load(file, context) {
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {
    filename: file,
  });
}

const game = {
  mode: 'pve',
  bases: { won: false, lost: false },
  world: { _playerTeam: 'ally' },
};
const context = {
  window: {
    VF: {
      game,
      Feel: {
        conquest: {
          tickets: 1000,
          roundSec: 2700,
          bleedInterval: 1,
          sweepSec: 60,
          neutralizeSec: 10,
          captureSec: 10,
          captureMaxPlayers: 4,
          captureExtraSpeed: 0.25,
          emptyRecoveryMul: 0.35,
        },
      },
    },
  },
  console,
  performance,
  setTimeout,
  clearTimeout,
};

load('js/conquest.js', context);
const C = context.window.VF.Conquest;
C.active = true;
C.phase = 'running';
C.matchId = 'test-match';
C.ticketsMax = 1000;
C.tickets = { ally: 1000, enemy: 1000 };
C._ended = false;

function flag(owner) {
  return {
    letter: 'A',
    owner,
    capture: owner === 'ally' ? 1 : owner === 'enemy' ? -1 : 0,
    phase: owner === 'neutral' ? 'neutral' : 'held',
    attackingTeam: null,
    progress: owner === 'neutral' ? 0 : 1,
    resumePhase: null,
    contested: false,
    allyN: 0,
    enemyN: 0,
    radius: 30,
  };
}

const twoPhase = flag('enemy');
C._tickFlagCapture(twoPhase, { ally: 1, enemy: 0 }, 5);
ok(twoPhase.owner === 'enemy', 'owner changed before neutralization completed');
ok(twoPhase.phase === 'neutralizing', 'neutralization phase was not entered');
ok(Math.abs(twoPhase.progress - 0.5) < 0.001, 'neutralization progress is incorrect');

C._tickFlagCapture(twoPhase, { ally: 1, enemy: 1 }, 3);
ok(twoPhase.phase === 'contested', 'contested phase was not entered');
ok(Math.abs(twoPhase.progress - 0.5) < 0.001, 'contest did not pause progress');

C._tickFlagCapture(twoPhase, { ally: 1, enemy: 0 }, 5);
ok(twoPhase.owner === 'neutral', 'flag did not become neutral after phase one');
ok(twoPhase.phase === 'neutral', 'neutral phase is incorrect');

C._tickFlagCapture(twoPhase, { ally: 1, enemy: 0 }, 10);
ok(twoPhase.owner === 'ally', 'flag did not complete phase-two capture');
ok(C._isFullyHeld(twoPhase, 'ally'), 'completed flag is not fully held');

const accelerated = flag('neutral');
C._tickFlagCapture(accelerated, { ally: 4, enemy: 0 }, 6);
ok(accelerated.owner === 'ally', 'four-player capture acceleration did not complete in time');

C.flags = [flag('ally'), flag('ally'), flag('enemy')];
C._bleedAcc = 0;
C._bleedInterval = 1;
C._tickBleed(1);
ok(C.tickets.ally === 999, 'enemy-held flag did not bleed ally tickets');
ok(C.tickets.enemy === 998, 'per-flag bleed did not drain two enemy tickets');

const beforeCasualty = C.tickets.ally;
const casualtyId = C.onDeath('ally', { lifeId: 'life-1', subjectId: 'ai-1' });
ok(casualtyId === 'life-1', 'casualty id was not preserved');
ok(C.tickets.ally === beforeCasualty - 1, 'final casualty did not deduct one ticket');
C.onDeath('ally', { lifeId: 'life-1', subjectId: 'ai-1' });
ok(C.tickets.ally === beforeCasualty - 1, 'duplicate casualty deducted tickets twice');

const pendingId = C.onDeath('enemy', {
  lifeId: 'life-revive',
  subjectId: 'ai-2',
  defer: true,
});
const beforeRevive = C.tickets.enemy;
ok(C.reviveCasualty(pendingId, { reviverId: 'ai-3' }), 'pending casualty could not be revived');
ok(C.tickets.enemy === beforeRevive, 'successful revive deducted a ticket');
ok(!C.finalizeCasualty(pendingId), 'revived casualty was finalized again');

const beforePlayerDeploy = C.tickets.ally;
const playerCasualty = C.onPlayerDown('ally', {
  lifeId: 'player-life-1',
  subjectId: 'player-local',
  defer: true,
});
ok(C.tickets.ally === beforePlayerDeploy, 'downed player deducted a ticket before deploy');
ok(
  C.finalizeCasualty(playerCasualty, { reason: 'deploy' }),
  'deploy did not finalize player casualty'
);
ok(C.tickets.ally === beforePlayerDeploy - 1, 'confirmed deploy did not deduct one ticket');

C.flags = [flag('ally'), flag('ally'), flag('ally')];
C._sweepAlly = 0;
C._sweepEnemy = 0;
C._tickSweep(59.9);
ok(C._sweepAlly < 60, 'sweep completed too early');
C._tickSweep(0.2);
ok(C._sweepAlly >= 60, 'all-flag sweep did not reach 60 seconds');
C.flags[1].contested = true;
C.flags[1].phase = 'contested';
C._tickSweep(0.1);
ok(C._sweepAlly === 0, 'contested flag did not cancel sweep timer');

load('js/squads.js', context);
const Squads = context.window.VF.Squads;
const player = { entityId: 'player-local', team: 'ally', alive: true };
const blue = [];
const red = [];
for (let i = 0; i < 31; i++) blue.push({ entityId: 'blue-' + i, team: 'ally', alive: true });
for (let i = 0; i < 32; i++) red.push({ entityId: 'red-' + i, team: 'enemy', alive: true });
const squadGame = { player, world: { _playerTeam: 'ally' }, ai: { blue, red } };
context.window.VF.game = squadGame;
Squads.buildRosters(squadGame);
ok(Squads.squads.ally.length === 8, 'ally roster was not split into eight squads');
ok(Squads.squads.enemy.length === 8, 'enemy roster was not split into eight squads');
ok(
  Squads.squads.ally.every((squad) => squad.memberIds.length === 4),
  'ally squad size is not four'
);
ok(Squads.areSquadmates('player-local', 'blue-0'), 'squadmate lookup failed');
ok(!Squads.areSquadmates('player-local', 'blue-4'), 'different squads were merged');

const orderFlag = flag('neutral');
orderFlag.letter = 'C';
C.flags = [orderFlag];
C.active = true;
C._ended = false;
C.elapsed = 10;
const firstSquad = Squads.squads.ally[0];
const order = Squads.issueOrder(firstSquad.id, 'C', 'attack', firstSquad.leaderId);
ok(order && order.status === 'active', 'leader could not issue squad order');
ok(
  !Squads.issueOrder(firstSquad.id, 'C', 'defend', 'not-the-leader'),
  'non-leader issued a squad order'
);

load('js/net-protocol.js', context);
const Net = context.window.VF.NetProtocol;
const snapshot = C.getStateSnapshot();
snapshot.matchId = 'network-test';
const sum = Net.checksum(snapshot);
const env = Net.envelope(
  'conquest-snapshot',
  { snapshot, checksum: sum },
  { matchId: snapshot.matchId, seq: 1 }
);
ok(Net.validateEnvelope(env).ok, 'valid network envelope was rejected');
ok(Net.validateSnapshot(snapshot).ok, 'valid conquest snapshot was rejected');
const tampered = JSON.parse(JSON.stringify(snapshot));
tampered.tickets.ally--;
ok(Net.checksum(tampered) !== sum, 'snapshot checksum did not detect ticket divergence');
const duplicate = Object.assign({}, env, { seq: -1 });
ok(!Net.validateEnvelope(duplicate).ok, 'invalid sequence was accepted');

const perfFlag = flag('neutral');
const perfStart = performance.now();
for (let i = 0; i < 100000; i++) {
  C._tickFlagCapture(perfFlag, { ally: i % 3 === 0 ? 2 : 0, enemy: 0 }, 1 / 60);
}
const perfMs = performance.now() - perfStart;
ok(perfMs < 2500, 'rule simulation exceeded generous CPU budget: ' + perfMs.toFixed(1) + 'ms');

console.log(
  JSON.stringify(
    {
      ok: true,
      rules: 'two-phase capture, contest, bleed, casualty, revive, sweep',
      squads: { ally: 8, enemy: 8, size: 4 },
      networkChecksum: sum,
      ruleSteps: 100000,
      rulePerfMs: Number(perfMs.toFixed(2)),
    },
    null,
    2
  )
);
