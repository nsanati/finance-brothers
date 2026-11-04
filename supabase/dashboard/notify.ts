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

// Called by the app right after someone adds an expense, records a payment,
// or sends/accepts a friend invite. Notifies the other people involved.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const db = adminClient();
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: auth } = await db.auth.getUser(token);
    const caller = auth?.user?.id;
    if (!caller) return json({ error: "Not signed in" }, 401);

    const { type, id } = await req.json();
    const { data: me } = await db.from("profiles").select("display_name").eq("id", caller).single();
    const who = me?.display_name ?? "A friend";

    if (type === "expense") {
      const { data: e } = await db.from("expenses")
        .select("id, description, amount_cents, paid_by, created_by, group_id, groups(name), expense_splits(user_id, share_cents)")
        .eq("id", id).single();
      if (!e || e.created_by !== caller) return json({ error: "Not allowed" }, 403);
      const groupName = (e.groups as { name: string } | null)?.name ?? "your group";
      const targets = [...e.expense_splits.map((s: { user_id: string }) => s.user_id), e.paid_by].filter((u) => u !== caller);
      // Per-person message so each friend sees their own share.
      let sent = 0;
      for (const uid of new Set(targets)) {
        const share = e.expense_splits.find((s: { user_id: string }) => s.user_id === uid)?.share_cents ?? 0;
        const line = uid === e.paid_by ? `You paid ${usd(e.amount_cents)}` : `Your share: ${usd(share)}`;
        sent += await pushToUsers(db, [uid], {
          title: `${groupName}: ${e.description}`,
          body: `${who} added ${usd(e.amount_cents)}. ${line}.`,
          url: `./?group=${e.group_id}`,
          tag: `expense-${e.id}`,
        });
      }
      return json({ sent });
    }

    if (type === "payment") {
      const { data: p } = await db.from("payments")
        .select("id, from_user, to_user, amount_cents, created_by, group_id, groups(name)").eq("id", id).single();
      if (!p || p.created_by !== caller) return json({ error: "Not allowed" }, 403);
      const other = p.from_user === caller ? p.to_user : p.from_user;
      const groupName = (p.groups as { name: string } | null)?.name ?? "your group";
      const sent = await pushToUsers(db, [other], {
        title: `${groupName}: payment recorded`,
        body: p.to_user === other
          ? `${who} paid you ${usd(p.amount_cents)}.`
          : `${who} marked your ${usd(p.amount_cents)} payment as received.`,
        url: `./?group=${p.group_id}`,
      });
      return json({ sent });
    }

    if (type === "friend_request" || type === "friend_accept") {
      const { data: f } = await db.from("friendships").select("requester, addressee, status").eq("id", id).single();
      if (!f) return json({ error: "Not found" }, 404);
      if (type === "friend_request" && f.requester === caller) {
        return json({ sent: await pushToUsers(db, [f.addressee], {
          title: "New friend invite", body: `${who} wants to split bills with you on Split Tab.`, url: "./?tab=friends" }) });
      }
      if (type === "friend_accept" && f.addressee === caller && f.status === "accepted") {
        return json({ sent: await pushToUsers(db, [f.requester], {
          title: "Invite accepted", body: `${who} accepted your friend invite.`, url: "./?tab=friends" }) });
      }
      return json({ error: "Not allowed" }, 403);
    }

    return json({ error: "Unknown type" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "Server error" }, 500);
  }
});
