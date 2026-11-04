import React, { useMemo, useState } from "react";
import { useApp } from "../App";
import { supabase, notify, friendlyError } from "../lib/supabase";
import { equalSplit, formatUSD } from "../lib/ledger";
import { Sheet, Avatar, todayISO, toCents } from "./ui";

export default function ExpenseSheet({ group, members, expense, onClose, onSaved }) {
  const { me, toast } = useApp();
  const memberIds = members.map((m) => m.id);
  const [desc, setDesc] = useState(expense?.description || "");
  const [amount, setAmount] = useState(expense ? (expense.amount_cents / 100).toFixed(2) : "");
  const [date, setDate] = useState(expense?.spent_on || todayISO());
  const [paidBy, setPaidBy] = useState(expense?.paid_by || me.id);
  const [mode, setMode] = useState(expense?.split_mode || "equal");
  const [parts, setParts] = useState(() => new Set(expense ? expense.splits.map((s) => s.user_id) : memberIds));
  const [exact, setExact] = useState(() =>
    Object.fromEntries(memberIds.map((id) => {
      const s = expense?.splits.find((x) => x.user_id === id);
      return [id, s ? (s.share_cents / 100).toFixed(2) : ""];
    })));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const total = toCents(amount) || 0;
  const chosen = memberIds.filter((id) => parts.has(id));
  const shares = useMemo(() => {
    if (mode === "equal") return equalSplit(total, chosen);
    return Object.fromEntries(chosen.map((id) => [id, toCents(exact[id]) || 0]));
  }, [mode, total, chosen.join(), exact]);
  const assigned = Object.values(shares).reduce((a, b) => a + b, 0);
  const left = total - assigned;

  const toggle = (id) => {
    const s = new Set(parts);
    s.has(id) ? s.delete(id) : s.add(id);
    setParts(s);
  };
  const switchMode = (m) => {
    if (m === "exact") {
      const eq = equalSplit(total, chosen);
      setExact((x) => Object.fromEntries(memberIds.map((id) => [id, x[id] || (eq[id] != null ? (eq[id] / 100).toFixed(2) : "")])));
    }
    setMode(m);
  };

  async function save(e) {
    e.preventDefault();
    setErr("");
    if (!desc.trim()) return setErr("Add a short description, like “Dinner at Bavel”.");
    if (!(total > 0)) return setErr("Enter the bill total.");
    if (!chosen.length) return setErr("Pick at least one person who's part of this bill.");
    if (mode === "exact" && left !== 0) {
      return setErr(left > 0 ? `${formatUSD(left)} still needs to be assigned to someone.` : `Shares are ${formatUSD(-left)} more than the total.`);
    }
    setBusy(true);
    const { data: id, error } = await supabase.rpc("save_expense", {
      p_id: expense?.id || null, p_group: group.id, p_description: desc.trim(), p_amount: total,
      p_paid_by: paidBy, p_spent_on: date, p_mode: mode,
      p_splits: chosen.map((uid) => ({ user_id: uid, share_cents: shares[uid] })),
    });
    setBusy(false);
    if (error) return setErr(friendlyError(error));
    if (!expense) notify("expense", id);
    toast(expense ? "Changes saved" : "Expense added");
    onSaved();
  }

  async function del() {
    const { error } = await supabase.from("expenses").delete().eq("id", expense.id);
    if (error) return setErr(friendlyError(error));
    toast("Expense deleted");
    onSaved();
  }

  return (
    <Sheet title={expense ? "Edit expense" : "Add expense"} onClose={onClose}>
      <form className="stack-sm" onSubmit={save} noValidate>
        <label className="field"><span className="label">Description</span>
          <input id="ex-desc" value={desc} maxLength={80} onChange={(e) => setDesc(e.target.value)} placeholder="Dinner at Bavel" autoFocus={!expense} /></label>
        <div className="two">
          <label className="field"><span className="label">Total ($)</span>
            <input id="ex-amt" className="num" type="number" inputMode="decimal" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></label>
          <label className="field"><span className="label">Date</span>
            <input id="ex-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <label className="field"><span className="label">Paid by</span>
          <select id="ex-paid" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {members.map((m) => <option key={m.id} value={m.id}>{m.id === me.id ? "You" : m.display_name}</option>)}
          </select></label>

        <div className="between wrap-row">
          <span className="label">Who's involved</span>
          <div className="seg small-seg">
            <button type="button" aria-pressed={mode === "equal"} onClick={() => switchMode("equal")}>Split equally</button>
            <button type="button" aria-pressed={mode === "exact"} onClick={() => switchMode("exact")}>Exact amounts</button>
          </div>
        </div>
        <div className="list">
          {members.map((m) => {
            const on = parts.has(m.id);
            return (
              <div className="row-item" key={m.id}>
                <input type="checkbox" id={"ex-p-" + m.id} checked={on} onChange={() => toggle(m.id)} />
                <label htmlFor={"ex-p-" + m.id} className="grow row-label"><Avatar person={m} size={26} />{m.id === me.id ? "You" : m.display_name}</label>
                {mode === "exact" && on ? (
                  <input className="share num" type="number" inputMode="decimal" step="0.01" min="0" id={"ex-x-" + m.id}
                    aria-label={`${m.display_name}'s share`} value={exact[m.id]} onChange={(e) => setExact({ ...exact, [m.id]: e.target.value })} placeholder="0.00" />
                ) : <span className="share num muted">{on ? formatUSD(shares[m.id] || 0) : "—"}</span>}
              </div>
            );
          })}
        </div>
        <div className="between small">
          <button type="button" className="btn link sm" onClick={() => setParts(new Set(memberIds))}>Everyone</button>
          <span className={mode === "exact" && left !== 0 ? "neg" : "muted"}>
            {mode === "exact" && left !== 0 ? (left > 0 ? `${formatUSD(left)} left to assign` : `${formatUSD(-left)} over`) : `${chosen.length} of ${members.length} people`}
          </span>
        </div>

        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy}>{busy ? "Saving…" : expense ? "Save changes" : "Add expense"}</button>
        {expense && (confirmDel ? (
          <div className="confirm"><span className="grow small">Delete this expense for everyone?</span>
            <button type="button" className="btn danger sm" onClick={del}>Delete</button>
            <button type="button" className="btn sm" onClick={() => setConfirmDel(false)}>Keep</button></div>
        ) : <button type="button" className="btn link danger" onClick={() => setConfirmDel(true)}>Delete expense</button>)}
      </form>
    </Sheet>
  );
}
