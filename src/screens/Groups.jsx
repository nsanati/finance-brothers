import React, { useCallback, useEffect, useState } from "react";
import { useApp } from "../App";
import { supabase, friendlyError } from "../lib/supabase";
import { computeLedger, formatUSD } from "../lib/ledger";
import { Avatar, Sheet, Empty } from "../components/ui";
import { useFriendships } from "./Friends";

export const isMonthEnd = () => {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() >= last - 4 || d.getDate() <= 2;
};

export default function Groups() {
  const { me, go } = useApp();
  const [groups, setGroups] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("groups")
      .select("id, name, simplify, created_at, group_members(user_id, profiles(id, display_name)), expenses(paid_by, amount_cents, expense_splits(user_id, share_cents)), payments(from_user, to_user, amount_cents)")
      .order("created_at", { ascending: true });
    if (error) { setGroups([]); return; }
    setGroups(data.map((g) => {
      const ids = g.group_members.map((m) => m.user_id);
      const L = computeLedger(ids, g.expenses.map((e) => ({ ...e, splits: e.expense_splits })), g.payments);
      const debts = g.simplify ? L.simplified : L.pairwise;
      return { ...g, mine: L.balances[me.id] || 0, myDebts: debts.filter((d) => d.from === me.id) };
    }));
  }, [me.id]);

  useEffect(() => {
    load();
    const ch = supabase.channel("groups-home")
      .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_members" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "groups" }, load)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [load]);

  const total = (groups || []).reduce((s, g) => s + g.mine, 0);
  const oweCount = (groups || []).reduce((s, g) => s + g.myDebts.length, 0);

  return (
    <div className="stack">
      <header className="between">
        <div><span className="label">Hi {me.display_name.split(" ")[0]}</span><h1>Your groups</h1></div>
        <button className="btn primary" onClick={() => setCreating(true)}>New group</button>
      </header>

      {groups && groups.length > 0 && (
        <div className="hero">
          <span className="label">Overall</span>
          <span className={"big num " + (total > 0 ? "pos" : total < 0 ? "neg" : "")}>
            {total > 0 ? "+" : total < 0 ? "−" : ""}{formatUSD(Math.abs(total))}
          </span>
          <span className="muted small">{total > 0 ? "Friends owe you overall." : total < 0 ? "You owe friends overall." : "You're all settled up."}</span>
        </div>
      )}

      {isMonthEnd() && oweCount > 0 && (
        <div className="notice warn">
          <b>Month-end settle-up.</b> You have {oweCount} {oweCount === 1 ? "payment" : "payments"} to make. Open a group and tap “Mark paid” once you've paid.
        </div>
      )}

      {groups === null ? <p className="muted">Loading…</p> : groups.length ? (
        <div className="list">
          {groups.map((g) => (
            <button className="row-item press" key={g.id} onClick={() => go({ name: "group", gid: g.id })}>
              <div className="avatars">{g.group_members.slice(0, 3).map((m) => <Avatar key={m.user_id} person={m.profiles} size={28} />)}</div>
              <div className="grow"><b>{g.name}</b><div className="muted small">{g.group_members.length} {g.group_members.length === 1 ? "person" : "people"}</div></div>
              <div className="right">
                {g.mine === 0 ? <span className="muted small">settled</span> : (
                  <><div className={"small " + (g.mine > 0 ? "pos" : "neg")}>{g.mine > 0 ? "you're owed" : "you owe"}</div>
                    <div className={"num " + (g.mine > 0 ? "pos" : "neg")}>{formatUSD(Math.abs(g.mine))}</div></>
                )}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Empty title="Start your first group" action={<button className="btn primary" onClick={() => setCreating(true)}>Create a group</button>}>
          A group is the friends you split bills with, like “Friday dinners” or “Vegas trip”. Add friends first on the Friends tab, then create a group with them.
        </Empty>
      )}

      {creating && <NewGroupSheet onClose={() => setCreating(false)} onCreated={(gid) => go({ name: "group", gid })} />}
    </div>
  );
}

function NewGroupSheet({ onClose, onCreated }) {
  const { me, toast, go } = useApp();
  const { rows, other } = useFriendships(me.id);
  const friends = (rows || []).filter((f) => f.status === "accepted").map(other);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return setErr("Give the group a name.");
    setBusy(true);
    const { data: gid, error } = await supabase.rpc("create_group", { p_name: name.trim() });
    if (error) { setBusy(false); return setErr(friendlyError(error)); }
    for (const uid of picked) await supabase.rpc("add_group_member", { p_group: gid, p_user: uid });
    toast("Group created");
    onCreated(gid);
  }

  return (
    <Sheet title="New group" onClose={onClose}>
      <form className="stack-sm" onSubmit={create}>
        <label className="field"><span className="label">Group name</span>
          <input id="ng-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Friday dinners" autoFocus /></label>
        <span className="label">Add friends</span>
        {friends.length ? (
          <div className="list">
            {friends.map((p) => (
              <label className="row-item press" key={p.id} htmlFor={"ng-" + p.id}>
                <input type="checkbox" id={"ng-" + p.id} checked={picked.has(p.id)}
                  onChange={(e) => { const s = new Set(picked); e.target.checked ? s.add(p.id) : s.delete(p.id); setPicked(s); }} />
                <Avatar person={p} size={28} /><span className="grow">{p.display_name} <span className="muted small">@{p.username}</span></span>
              </label>
            ))}
          </div>
        ) : (
          <p className="muted small">You don't have friends on Split Tab yet. You can create the group now and add people later, or <button type="button" className="btn link inline" onClick={() => go({ name: "friends" })}>find friends first</button>.</p>
        )}
        {err && <p className="error">{err}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? "Creating…" : "Create group"}</button>
      </form>
    </Sheet>
  );
}
