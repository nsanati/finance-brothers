import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLedger, equalSplit } from "../src/lib/ledger.js";

const exp = (paid_by, amount_cents, shares) => ({
  paid_by, amount_cents, splits: Object.entries(shares).map(([user_id, share_cents]) => ({ user_id, share_cents })),
});

test("equal split hands leftover cents to the first people", () => {
  assert.deepEqual(equalSplit(1000, ["a", "b", "c"]), { a: 334, b: 333, c: 333 });
});

test("one dinner: two friends owe the payer", () => {
  const L = computeLedger(["a", "b", "c"], [exp("a", 9000, { a: 3000, b: 3000, c: 3000 })], []);
  assert.deepEqual(L.balances, { a: 6000, b: -3000, c: -3000 });
  assert.equal(L.pairwise.length, 2);
  assert.equal(L.simplified.length, 2);
});

test("simplify removes a chain: a→b→c becomes a→c", () => {
  const L = computeLedger(["a", "b", "c"], [exp("b", 1000, { a: 1000 }), exp("c", 1000, { b: 1000 })], []);
  assert.equal(L.pairwise.length, 2);
  assert.deepEqual(L.simplified, [{ from: "a", to: "c", amount: 1000 }]);
});

test("payments reduce what's owed, both ways", () => {
  const L = computeLedger(["a", "b"], [exp("a", 2000, { a: 1000, b: 1000 })], [{ from_user: "b", to_user: "a", amount_cents: 400 }]);
  assert.deepEqual(L.pairwise, [{ from: "b", to: "a", amount: 600 }]);
  assert.deepEqual(L.simplified, [{ from: "b", to: "a", amount: 600 }]);
  const settled = computeLedger(["a", "b"], [exp("a", 2000, { a: 1000, b: 1000 })], [{ from_user: "b", to_user: "a", amount_cents: 1000 }]);
  assert.equal(settled.pairwise.length, 0);
  assert.equal(settled.simplified.length, 0);
});

test("opposite debts net out pairwise", () => {
  const L = computeLedger(["a", "b"], [exp("a", 1000, { b: 1000 }), exp("b", 300, { a: 300 })], []);
  assert.deepEqual(L.pairwise, [{ from: "b", to: "a", amount: 700 }]);
});
