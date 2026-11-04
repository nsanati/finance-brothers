// Called by the app right after someone adds an expense, records a payment,
// or sends/accepts a friend invite. Notifies the other people involved.
import { adminClient, cors, pushToUsers, usd } from "../_shared/push.ts";

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
