// Balance math, shared by the app and the month-end reminder function.
// All amounts are integer cents.
//
// expenses: [{ paid_by, amount_cents, splits: [{ user_id, share_cents }] }]
// payments: [{ from_user, to_user, amount_cents }]
// Returns { balances, pairwise, simplified }:
//   balances[userId] > 0  → the group owes them; < 0 → they owe the group
//   pairwise / simplified: [{ from, to, amount }] — `from` pays `to`

export function computeLedger(memberIds, expenses, payments) {
  const balances = {};
  for (const id of memberIds) balances[id] = 0;
  const owe = new Map(); // "a|b" → cents a owes b
  const add = (a, b, c) => {
    if (a === b || !c) return;
    const k = a + "|" + b;
    owe.set(k, (owe.get(k) || 0) + c);
  };

  for (const e of expenses) {
    balances[e.paid_by] = (balances[e.paid_by] || 0) + e.amount_cents;
    for (const s of e.splits || []) {
      balances[s.user_id] = (balances[s.user_id] || 0) - s.share_cents;
      add(s.user_id, e.paid_by, s.share_cents);
    }
  }
  for (const p of payments) {
    balances[p.from_user] = (balances[p.from_user] || 0) + p.amount_cents;
    balances[p.to_user] = (balances[p.to_user] || 0) - p.amount_cents;
    add(p.from_user, p.to_user, -p.amount_cents);
  }

  const pairwise = [];
  const seen = new Set();
  for (const k of owe.keys()) {
    const [a, b] = k.split("|");
    const pair = a < b ? a + "|" + b : b + "|" + a;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const net = (owe.get(a + "|" + b) || 0) - (owe.get(b + "|" + a) || 0);
    if (net > 0) pairwise.push({ from: a, to: b, amount: net });
    else if (net < 0) pairwise.push({ from: b, to: a, amount: -net });
  }
  pairwise.sort((x, y) => y.amount - x.amount);

  // Fewest payments: repeatedly match the biggest debtor with the biggest creditor.
  const creditors = [], debtors = [];
  for (const [id, v] of Object.entries(balances)) {
    if (v > 0) creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  creditors.sort((a, b) => b.v - a.v);
  debtors.sort((a, b) => b.v - a.v);
  const simplified = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const x = Math.min(debtors[i].v, creditors[j].v);
    if (x > 0) simplified.push({ from: debtors[i].id, to: creditors[j].id, amount: x });
    debtors[i].v -= x;
    creditors[j].v -= x;
    if (debtors[i].v === 0) i++;
    if (creditors[j].v === 0) j++;
  }

  return { balances, pairwise, simplified };
}

// Split a total into equal integer-cent shares; leftover cents go to the first people.
export function equalSplit(totalCents, userIds) {
  if (!userIds.length) return {};
  const base = Math.floor(totalCents / userIds.length);
  let rem = totalCents - base * userIds.length;
  const out = {};
  for (const id of userIds) {
    out[id] = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  }
  return out;
}

export const formatUSD = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents || 0) / 100);
