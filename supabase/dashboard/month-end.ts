// Single-file version for the Supabase dashboard editor.
import webpush from "npm:web-push@3.6.7";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

let vapidReady = false;
function setupVapid() {
  if (vapidReady) return;
  webpush.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
    Deno.env.get("VAPID_PUBLIC_KEY")!,
    Deno.env.get("VAPID_PRIVATE_KEY")!,
  );
  vapidReady = true;
}

function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

type PushMessage = { title: string; body: string; url?: string; tag?: string };

/** Send a notification to every device the given users have turned notifications on for. */
async function pushToUsers(db: SupabaseClient, userIds: string[], msg: PushMessage) {
  setupVapid();
  const ids = [...new Set(userIds)];
  if (!ids.length) return 0;
  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", ids);
  if (error) throw error;
  let sent = 0;
  await Promise.all(
    (subs ?? []).map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(msg),
          { TTL: 60 * 60 * 24 },
        );
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        // The device unsubscribed or the browser dropped it: forget it.
        if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
        else console.error("push failed", code, e);
      }
    }),
  );
  return sent;
}

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Balance math, shared by the app and the month-end reminder function.
// All amounts are integer cents.
//
// expenses: [{ paid_by, amount_cents, splits: [{ user_id, share_cents }] }]
// payments: [{ from_user, to_user, amount_cents }]
// Returns { balances, pairwise, simplified }:
//   balances[userId] > 0  → the group owes them; < 0 → they owe the group
//   pairwise / simplified: [{ from, to, amount }] — `from` pays `to`

function computeLedger(memberIds: string[], expenses: any[], payments: any[]): any {
  const balances: Record<string, number> = {};
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

  const pairwise: any[] = [];
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
  const creditors: any[] = [], debtors: any[] = [];
  for (const [id, v] of Object.entries(balances)) {
    if (v > 0) creditors.push({ id, v });
    else if (v < 0) debtors.push({ id, v: -v });
  }
  creditors.sort((a, b) => b.v - a.v);
  debtors.sort((a, b) => b.v - a.v);
  const simplified: any[] = [];
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

// Monthly settle-up reminder. Run by a pg_cron job (see README).
// Sends each person what they owe and what they're owed, per group.

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
