import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../App";
import { supabase, notify, friendlyError } from "../lib/supabase";
import { computeLedger, formatUSD } from "../lib/ledger";
import { Avatar, Sheet, Empty, todayISO, toCents } from "../components/ui";
import ExpenseSheet from "../components/ExpenseSheet";
import { useFriendships } from "./Friends";
import { isMonthEnd } from "./Groups";

function useGroup(gid) {
  const [state, setState] = useState({ loading: true });
  const load = useCallback(async () => {
    const [g, m, e, p] = await Promise.all([
      supabase.from("groups").select("*").eq("id", gid).maybeSingle(),
      supabase.from("group_members").select("user_id, joined_at, profiles(id, username, display_name)").eq("group_id", gid).order("joined_at"),
      supabase.from("expenses").select("*, expense_splits(user_id, share_cents)").eq("group_id", gid).order("spent_on", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("payments").select("*").eq("group_id", gid).order("paid_on", { ascending: false }),
    ]);
    if (!g.data) return setState({ loading: false, missing: true });
    setState({
      loading: false,
      group: g.data,
      members: (m.data || []).map((x) => x.profiles),
      expenses: (e.data || []).map((x) => ({ ...x, splits: x.expense_splits })),
      payments: p.data || [],
    });
  }, [gid]);

  useEffect(() => {
    load();
    const f = `group_id=eq.${gid}`;
    const ch = supabase.channel("group-" + gid)
      .on("postgres_changes", { event: "*", schema: "public", table: "expenses", filter: f }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "expense_splits" }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "payments", filter: f }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "group_members", filter: f }, load)
      .on("postgres_changes", { event: "*", schema: "public", table: "groups", filter: `id=eq.${gid}` }, load)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [gid, load]);
  return [state, load];
}

export default function Group({ gid }) {
  const { me, go, toast } = useApp();
  const [s, reload] = useGroup(gid);
  const [tab, setTab] = useState("expenses");
  const [editing, setEditing] = useState(null); // null | "new" | expense
  const [settings, setSettings] = useState(false);

  const L = useMemo(() => s.group ? computeLedger(s.members.map((m) => m.id), s.expenses, s.payments) : null, [s]);
  if (s.loading) return <p className="muted">Loading…</p>;
  if (s.missing) return <Empty title="Group not found" action={<button className="btn" onClick={() => go({ name: "groups" })}>Back to groups</button>}>You may have left this group, or it was deleted.</Empty>;

  const people = Object.fromEntries(s.members.map((m) => [m.id, m]));
  const nameOf = (id) => (id === me.id ? "You" : people[id]?.display_name || "Former member");
  const debts = s.group.simplify ? L.simplified : L.pairwise;
  const mine = L.balances[me.id] || 0;

  return (
    <div className="stack">
      <header className="stack-xs">
        <button className="btn link back" onClick={() => go({ name: "groups" })}>‹ Groups</button>
        <div className="between">
          <h1>{s.group.name}</h1>
          <button className="btn sm" onClick={() => setSettings(true)}>Settings</button>
        </div>
        <div className="avatars">{s.members.map((m) => <Avatar key={m.id} person={m} size={26} />)}</div>
      </header>

      <div className="hero">
        <span className="label">Your balance here</span>
        <span className={"big num " + (mine > 0 ? "pos" : mine < 0 ? "neg" : "")}>{mine > 0 ? "+" : mine < 0 ? "−" : ""}{formatUSD(Math.abs(mine))}</span>
        <span className="muted small">{mine > 0 ? "The group owes you." : mine < 0 ? "You owe the group." : "You're settled up."}</span>
      </div>

      {isMonthEnd() && debts.length > 0 && (
        <div className="notice warn"><b>Month-end settle-up.</b> {debts.length} open {debts.length === 1 ? "payment" : "payments"} in this group. See Balances.</div>
      )}

      <div className="seg" role="tablist">
        {[["expenses", "Expenses"], ["balances", "Balances"]].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "expenses"
        ? <Activity s={s} me={me} nameOf={nameOf} onEdit={setEditing} reload={reload} toast={toast} />
        : <Balances s={s} L={L} debts={debts} me={me} nameOf={nameOf} people={people} reload={reload} toast={toast} />}

      <button className="fab" onClick={() => setEditing("new")}>+ Add expense</button>

      {editing && (
        <ExpenseSheet group={s.group} members={s.members} expense={editing === "new" ? null : editing}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
      {settings && <GroupSettings s={s} mine={mine} onClose={() => setSettings(false)} reload={reload} />}
    </div>
  );
}

function Activity({ s, me, nameOf, onEdit, reload, toast }) {
  const [undo, setUndo] = useState(null);
  const items = [
    ...s.expenses.map((e) => ({ k: "e", date: e.spent_on, at: e.created_at, ...e })),
    ...s.payments.map((p) => ({ k: "p", date: p.paid_on, at: p.created_at, ...p })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  if (!items.length) {
    return <Empty title="No expenses yet">{s.members.length < 2
      ? "Add friends to this group in Settings, then add your first bill."
      : "Tap “Add expense” after your next dinner or night out. Everyone in the group sees it right away."}</Empty>;
  }
  const months = [];
  for (const it of items) {
    const key = it.date.slice(0, 7);
    let m = months.find((x) => x.key === key);
    if (!m) months.push((m = { key, items: [] }));
    m.items.push(it);
  }
  async function delPayment(id) {
    const { error } = await supabase.from("payments").delete().eq("id", id);
    if (error) toast(friendlyError(error)); else { setUndo(null); reload(); }
  }
  return months.map((m) => {
    const [y, mo] = m.key.split("-").map(Number);
    const spent = m.items.filter((x) => x.k === "e").reduce((t, x) => t + x.amount_cents, 0);
    return (
      <section className="stack-sm" key={m.key}>
        <div className="between"><h2>{new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" })}</h2>
          <span className="muted small">Spent <span className="num">{formatUSD(spent)}</span></span></div>
        <div className="list">
          {m.items.map((it) => it.k === "e" ? (
            <button className="row-item press" key={it.id} onClick={() => onEdit(it)}>
              <DateBox iso={it.date} />
              <div className="grow"><b className="wrap">{it.description}</b>
                <div className="muted small">{nameOf(it.paid_by)} paid · split {it.splits.length} {it.splits.length === 1 ? "way" : "ways"}</div></div>
              <div className="right"><div className="num">{formatUSD(it.amount_cents)}</div><MyShare e={it} me={me} /></div>
            </button>
          ) : (
            <div className="row-item" key={it.id}>
              <DateBox iso={it.date} pay />
              <div className="grow"><b>{nameOf(it.from_user)} paid {nameOf(it.to_user).replace(/^You$/, "you")}</b><div className="muted small">Settle-up payment</div></div>
              <div className="right"><div className="num pos">{formatUSD(it.amount_cents)}</div>
                {undo === it.id
                  ? <button className="btn danger sm" onClick={() => delPayment(it.id)}>Confirm undo</button>
                  : <button className="btn link sm" onClick={() => setUndo(it.id)}>Undo</button>}</div>
            </div>
          ))}
        </div>
      </section>
    );
  });
}

function MyShare({ e, me }) {
  const share = e.splits.find((x) => x.user_id === me.id)?.share_cents || 0;
  if (e.paid_by === me.id) {
    const lent = e.amount_cents - share;
    return lent > 0 ? <div className="small pos">you lent {formatUSD(lent)}</div> : null;
  }
  return share ? <div className="small neg">you owe {formatUSD(share)}</div> : <div className="small muted">not involved</div>;
}

function DateBox({ iso, pay }) {
  const d = new Date(iso + "T12:00:00");
  return <div className={"datebox" + (pay ? " pay" : "")}><span>{d.toLocaleString("en-US", { month: "short" })}</span><b>{d.getDate()}</b></div>;
}

function Balances({ s, L, debts, me, nameOf, people, reload, toast }) {
  const [open, setOpen] = useState(null);
  const [amt, setAmt] = useState("");
  const [copied, setCopied] = useState(false);

  async function toggleSimplify(v) {
    const { error } = await supabase.from("groups").update({ simplify: v }).eq("id", s.group.id);
    if (error) toast(friendlyError(error)); else reload();
  }
  async function record(d) {
    const c = toCents(amt);
    if (!(c > 0)) return toast("Enter an amount above $0.");
    const { data, error } = await supabase.from("payments")
      .insert({ group_id: s.group.id, from_user: d.from, to_user: d.to, amount_cents: c, paid_on: todayISO(), created_by: me.id })
      .select("id").single();
    if (error) return toast(friendlyError(error));
    notify("payment", data.id);
    setOpen(null); toast("Payment recorded"); reload();
  }
  async function copyReminder() {
    const month = new Date().toLocaleString("en-US", { month: "long" });
    const text = `Settle-up time for ${s.group.name} (${month}):\n` +
      debts.map((d) => `• ${people[d.from]?.display_name} owes ${people[d.to]?.display_name} ${formatUSD(d.amount)}`).join("\n") +
      `\nMark it paid in Split Tab once you've sent it.`;
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    } catch { /* closed */ }
  }

  return (
    <div className="stack">
      <label className="switch" htmlFor="simplify">
        <input type="checkbox" id="simplify" checked={s.group.simplify} onChange={(e) => toggleSimplify(e.target.checked)} />
        <span className="grow"><b>Simplify group debts</b><br />
          <span className="muted small">Combine debts so the group settles in the fewest payments. Changes it for everyone.</span></span>
      </label>

      <section className="stack-sm">
        <div className="between"><h2>Who pays whom</h2>
          {debts.length > 0 && <button className="btn link" onClick={copyReminder}>{copied ? "Copied" : "Send reminder"}</button>}</div>
        {debts.length ? (
          <div className="list">
            {debts.map((d) => {
              const key = d.from + d.to;
              const involved = d.from === me.id || d.to === me.id;
              return (
                <div className={"row-item" + (involved ? " mine" : "")} key={key}>
                  <Avatar person={people[d.from] || { id: d.from, display_name: "?" }} />
                  <div className="grow"><b>{nameOf(d.from)}</b> {d.from === me.id ? "owe" : "owes"} <b>{nameOf(d.to).replace(/^You$/, "you")}</b>
                    <div className="num">{formatUSD(d.amount)}</div></div>
                  {open === key ? null : <button className="btn sm" onClick={() => { setOpen(key); setAmt((d.amount / 100).toFixed(2)); }}>Mark paid</button>}
                  {open === key && (
                    <form className="payform" onSubmit={(e) => { e.preventDefault(); record(d); }}>
                      <label className="sr" htmlFor="pay-amt">Amount paid</label>
                      <input id="pay-amt" type="number" inputMode="decimal" step="0.01" min="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} />
                      <button className="btn primary sm">Record</button>
                      <button type="button" className="btn link sm" onClick={() => setOpen(null)}>Cancel</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        ) : <div className="empty"><h2>All settled up</h2><p className="muted">Nobody owes anybody in this group.</p></div>}
      </section>

      <section className="stack-sm">
        <h2>Net per person</h2>
        <div className="list">
          {s.members.map((m) => {
            const v = L.balances[m.id] || 0;
            return (
              <div className="row-item" key={m.id}>
                <Avatar person={m} size={28} /><span className="grow">{m.id === me.id ? "You" : m.display_name}</span>
                <span className={"num small " + (v > 0 ? "pos" : v < 0 ? "neg" : "muted")}>{v > 0 ? "gets back " : v < 0 ? "owes " : ""}{formatUSD(Math.abs(v))}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function GroupSettings({ s, mine, onClose, reload }) {
  const { me, toast, go } = useApp();
  const { rows, other } = useFriendships(me.id);
  const inGroup = new Set(s.members.map((m) => m.id));
  const addable = (rows || []).filter((f) => f.status === "accepted").map(other).filter((p) => !inGroup.has(p.id));
  const [name, setName] = useState(s.group.name);
  const [leaving, setLeaving] = useState(false);

  async function rename(e) {
    e.preventDefault();
    if (!name.trim() || name.trim() === s.group.name) return;
    const { error } = await supabase.from("groups").update({ name: name.trim() }).eq("id", s.group.id);
    if (error) toast(friendlyError(error)); else { toast("Renamed"); reload(); }
  }
  async function add(p) {
    const { error } = await supabase.rpc("add_group_member", { p_group: s.group.id, p_user: p.id });
    if (error) toast(friendlyError(error)); else { toast(`${p.display_name} added`); reload(); }
  }
  async function leave() {
    const { error } = await supabase.from("group_members").delete().eq("group_id", s.group.id).eq("user_id", me.id);
    if (error) toast(friendlyError(error)); else { toast("You left the group"); go({ name: "groups" }); }
  }

  return (
    <Sheet title="Group settings" onClose={onClose}>
      <form className="row-form" onSubmit={rename}>
        <label className="field grow"><span className="label">Group name</span>
          <input id="gs-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn">Save</button>
      </form>

      <span className="label">Members</span>
      <div className="list">
        {s.members.map((m) => (
          <div className="row-item" key={m.id}><Avatar person={m} size={28} />
            <span className="grow">{m.display_name} <span className="muted small">@{m.username}</span></span></div>
        ))}
      </div>

      <span className="label">Add friends</span>
      {addable.length ? (
        <div className="list">
          {addable.map((p) => (
            <div className="row-item" key={p.id}><Avatar person={p} size={28} />
              <span className="grow">{p.display_name}</span><button className="btn primary sm" onClick={() => add(p)}>Add</button></div>
          ))}
        </div>
      ) : <p className="muted small">All your friends are already here. To add someone else, invite them on the <button className="btn link inline" onClick={() => go({ name: "friends" })}>Friends tab</button> first.</p>}

      <div className="danger-zone">
        {mine !== 0 ? (
          <p className="muted small">You can leave this group once your balance here is $0.00.</p>
        ) : leaving ? (
          <div className="row-form"><span className="grow small">Leave {s.group.name}? You won't see it anymore.</span>
            <button className="btn danger sm" onClick={leave}>Leave</button><button className="btn sm" onClick={() => setLeaving(false)}>Stay</button></div>
        ) : <button className="btn link danger" onClick={() => setLeaving(true)}>Leave group</button>}
      </div>
    </Sheet>
  );
}
