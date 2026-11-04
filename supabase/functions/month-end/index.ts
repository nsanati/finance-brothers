// Monthly settle-up reminder. Run by a pg_cron job (see README).
// Sends each person what they owe and what they're owed, per group.
import { adminClient, cors, pushToUsers, usd } from "../_shared/push.ts";
import { computeLedger } from "../_shared/ledger.js";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }
  const db = adminClient();

  const [{ data: groups }, { data: members }, { data: expenses }, { data: payments }, { data: profiles }] =
    await Promise.all([
      db.from("groups").select("id, name, simplify"),
      db.from("group_members").select("group_id, user_id"),
      db.from("expenses").select("group_id, paid_by, amount_cents, expense_splits(user_id, share_cents)"),
      db.from("payments").select("group_id, from_user, to_user, amount_cents"),
      db.from("profiles").select("id, display_name"),
    ]);
  const name = (id: string) => profiles?.find((p) => p.id === id)?.display_name ?? "someone";

  // userId → lines like "You owe Ara $12.00 (Friday dinners)"
  const lines = new Map<string, string[]>();
  const push = (u: string, s: string) => lines.set(u, [...(lines.get(u) ?? []), s]);

  for (const g of groups ?? []) {
    const ids = (members ?? []).filter((m) => m.group_id === g.id).map((m) => m.user_id);
    const exps = (expenses ?? []).filter((e) => e.group_id === g.id)
      .map((e) => ({ paid_by: e.paid_by, amount_cents: e.amount_cents, splits: e.expense_splits }));
    const pays = (payments ?? []).filter((p) => p.group_id === g.id);
    const L = computeLedger(ids, exps, pays);
    for (const d of g.simplify ? L.simplified : L.pairwise) {
      push(d.from, `You owe ${name(d.to)} ${usd(d.amount)} (${g.name})`);
      push(d.to, `${name(d.from)} owes you ${usd(d.amount)} (${g.name})`);
    }
  }

  let sent = 0;
  for (const [uid, ls] of lines) {
    sent += await pushToUsers(db, [uid], {
      title: "Time to settle up",
      body: ls.length > 3 ? `${ls.slice(0, 3).join(". ")}. +${ls.length - 3} more.` : ls.join(". ") + ".",
      url: "./",
      tag: "month-end",
    });
  }
  return new Response(JSON.stringify({ people: lines.size, sent }), { headers: { "Content-Type": "application/json" } });
});
