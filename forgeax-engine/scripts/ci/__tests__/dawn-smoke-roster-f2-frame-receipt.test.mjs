import assert from 'node:assert/strict';
import test from 'node:test';
import { parseObservedFrameReceipt } from '../run-dawn-smoke-roster.mjs';

const identity = { gateId: 'hello/direct-dawn', commandId: 'smoke' };

function receiptLine(framesObserved, overrides = {}) {
  return `[forgeax-smoke-receipt] ${JSON.stringify({
    schemaVersion: 1,
    ...identity,
    framesObserved,
    completed: true,
    ...overrides,
  })}`;
}

test('only one gate-specific receipt is an observed frame fact', () => {
  const receipt = parseObservedFrameReceipt(receiptLine(300), identity);
  assert.equal(receipt.framesObserved, 300);
  assert.equal(receipt.completed, true);
  assert.equal('framesExpected' in receipt, false);
  assert.equal(receipt.parserId, 'forgeax-smoke-receipt-v1');
});

for (const [name, output] of [
  ['expected-only output', 'framesExpected: 300'],
  ['environment-only output', 'SMOKE_MIN_FRAMES=300'],
  ['unrelated frame number', '999 frames'],
  ['short receipt', receiptLine(299)],
  ['wrong gate', receiptLine(300, { gateId: 'other/gate' })],
  ['wrong command', receiptLine(300, { commandId: 'other-command' })],
  ['incomplete receipt', receiptLine(300, { completed: false })],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseObservedFrameReceipt(output, identity), /receipt|frame|gate|command/i);
  });
}

test('rejects multiple receipts instead of selecting a maximum', () => {
  const output = `${receiptLine(300)}\n${receiptLine(301)}`;
  assert.throws(() => parseObservedFrameReceipt(output, identity), /multiple|receipt/i);
});
