import React, { useCallback, useEffect, useState } from "react";
import { useApp } from "../App";
import { supabase, notify, friendlyError } from "../lib/supabase";
import { Avatar } from "../components/ui";

export function useFriendships(uid) {
  const [rows, setRows] = useState(null);
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("friendships")
      .select("id, status, requester, addressee, created_at, req:profiles!friendships_requester_fkey(id, username, display_name), add:profiles!friendships_addressee_fkey(id, username, display_name)")
      .order("created_at", { ascending: false });
    setRows(data || []);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel("friends-" + uid)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, load)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [uid, load]);
  const other = (f) => (f.requester === uid ? f.add : f.req);
  return { rows, load, other };
}

export default function Friends() {
  const { me, toast } = useApp();
  const { rows, load, other } = useFriendships(me.id);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);

  useEffect(() => {
    const term = q.trim().replace(/^@/, "");
    if (term.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc("search_profiles", { q: term });
      setResults(data || []);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const relation = (pid) => (rows || []).find((f) => f.requester === pid || f.addressee === pid);

  async function invite(p) {
    const { data, error } = await supabase.from("friendships").insert({ requester: me.id, addressee: p.id }).select("id").single();
    if (error) return toast(friendlyError(error));
    notify("friend_request", data.id);
    toast(`Invite sent to ${p.display_name}`);
    load();
  }
  async function accept(f) {
    const { error } = await supabase.from("friendships").update({ status: "accepted" }).eq("id", f.id);
    if (error) return toast(friendlyError(error));
    notify("friend_accept", f.id);
    toast(`You and ${other(f).display_name} are now friends`);
    load();
  }
  async function remove(f) {
    const { error } = await supabase.from("friendships").delete().eq("id", f.id);
    if (error) return toast(friendlyError(error));
    setConfirmRemove(null);
    load();
  }
  async function shareApp() {
    const url = location.origin + import.meta.env.BASE_URL;
    const text = `Join me on Split Tab so we can split bills. Sign up here, then search for @${me.username}: ${url}`;
    try {
      if (navigator.share) await navigator.share({ title: "Split Tab", text });
      else { await navigator.clipboard.writeText(text); toast("Invite link copied"); }
    } catch { /* user closed the share sheet */ }
  }

  const incoming = (rows || []).filter((f) => f.status === "pending" && f.addressee === me.id);
  const outgoing = (rows || []).filter((f) => f.status === "pending" && f.requester === me.id);
  const friends = (rows || []).filter((f) => f.status === "accepted");

  return (
    <div className="stack">
      <header><span className="label">Friends</span><h1>Your people</h1></header>

      <section className="stack-sm">
        <label className="field">
          <span className="label">Find a friend</span>
          <input id="friend-search" type="search" autoCapitalize="none" autoCorrect="off" value={q}
            onChange={(e) => setQ(e.target.value)} placeholder="Username or exact email" />
        </label>
        {q.trim().length >= 2 && (
          <div className="list">
            {results.map((p) => {
              const r = relation(p.id);
              return (
                <div className="row-item" key={p.id}>
                  <Avatar person={p} />
                  <div className="grow"><b>{p.display_name}</b><div className="muted small">@{p.username}</div></div>
                  {!r && <button className="btn primary sm" onClick={() => invite(p)}>Invite</button>}
                  {r && r.status === "accepted" && <span className="pill">Friends</span>}
                  {r && r.status === "pending" && r.requester === me.id && <span className="pill">Invited</span>}
                  {r && r.status === "pending" && r.addressee === me.id && <button className="btn primary sm" onClick={() => accept(r)}>Accept</button>}
                </div>
              );
            })}
            {!searching && !results.length && (
              <div className="row-item col">
                <p className="muted">No one found. If they don't have an account yet, send them the app.</p>
                <button className="btn" onClick={shareApp}>Share invite link</button>
              </div>
            )}
          </div>
        )}
      </section>

      {incoming.length > 0 && (
        <section className="stack-sm">
          <h2>Invites for you</h2>
          <div className="list">
            {incoming.map((f) => (
              <div className="row-item" key={f.id}>
                <Avatar person={other(f)} />
                <div className="grow"><b>{other(f).display_name}</b><div className="muted small">@{other(f).username} wants to be friends</div></div>
                <button className="btn primary sm" onClick={() => accept(f)}>Accept</button>
                <button className="btn sm" onClick={() => remove(f)}>Decline</button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stack-sm">
        <div className="between"><h2>Friends</h2><button className="btn link" onClick={shareApp}>Invite someone new</button></div>
        {rows === null ? <p className="muted">Loading…</p> : friends.length ? (
          <div className="list">
            {friends.map((f) => (
              <div className="row-item" key={f.id}>
                <Avatar person={other(f)} />
                <div className="grow"><b>{other(f).display_name}</b><div className="muted small">@{other(f).username}</div></div>
                {confirmRemove === f.id
                  ? <><button className="btn danger sm" onClick={() => remove(f)}>Remove</button><button className="btn sm" onClick={() => setConfirmRemove(null)}>Keep</button></>
                  : <button className="btn link sm" onClick={() => setConfirmRemove(f.id)}>Remove</button>}
              </div>
            ))}
          </div>
        ) : (
          <div className="empty"><p className="muted">No friends yet. Search above by username or email, or share the invite link with people who haven't signed up.</p></div>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="stack-sm">
          <h2>Waiting for them</h2>
          <div className="list">
            {outgoing.map((f) => (
              <div className="row-item" key={f.id}>
                <Avatar person={other(f)} />
                <div className="grow"><b>{other(f).display_name}</b><div className="muted small">@{other(f).username} · invite sent</div></div>
                <button className="btn link sm" onClick={() => remove(f)}>Cancel</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
