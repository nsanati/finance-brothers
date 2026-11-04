import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { supabase, configured } from "./lib/supabase";
import Auth, { NewPassword } from "./screens/Auth";
import Groups from "./screens/Groups";
import Group from "./screens/Group";
import Friends from "./screens/Friends";
import Account from "./screens/Account";

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function readStartView() {
  const p = new URLSearchParams(location.search);
  if (p.get("group")) return { name: "group", gid: p.get("group") };
  if (p.get("tab") === "friends") return { name: "friends" };
  return { name: "groups" };
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [profile, setProfile] = useState(null);
  const [recovering, setRecovering] = useState(false);
  const [view, setView] = useState(readStartView);
  const [toastMsg, setToastMsg] = useState("");
  const [pendingInvites, setPendingInvites] = useState(0);

  const toast = useCallback((m) => {
    setToastMsg(m);
    clearTimeout(toast.t);
    toast.t = setTimeout(() => setToastMsg(""), 2600);
  }, []);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const uid = session?.user?.id;
  useEffect(() => {
    if (!uid) { setProfile(null); return; }
    let alive = true;
    const load = () => supabase.from("profiles").select("*").eq("id", uid).single()
      .then(({ data }) => alive && setProfile(data));
    load();
    // Count friend invites waiting for me, live.
    const countInvites = () => supabase.from("friendships").select("id", { count: "exact", head: true })
      .eq("addressee", uid).eq("status", "pending").then(({ count }) => alive && setPendingInvites(count || 0));
    countInvites();
    const ch = supabase.channel("invites-" + uid)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, countInvites)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [uid]);

  const go = (v) => {
    setView(v);
    history.replaceState(null, "", location.pathname); // drop ?group= after first use
    window.scrollTo(0, 0);
  };

  if (!configured) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Almost there</h1>
          <p className="muted">This copy of Split Tab isn't connected to a database yet. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> as described in the README, then rebuild.</p>
        </div>
      </div>
    );
  }
  if (session === undefined) return <div className="center-screen"><p className="muted">Loading…</p></div>;
  if (recovering && session) return <NewPassword onDone={() => setRecovering(false)} />;
  if (!session) return <Auth />;
  if (!profile) return <div className="center-screen"><p className="muted">Loading your account…</p></div>;

  const ctx = { session, me: profile, setProfile, toast, go, view };
  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <main className="page">
          {view.name === "groups" && <Groups />}
          {view.name === "group" && <Group key={view.gid} gid={view.gid} />}
          {view.name === "friends" && <Friends />}
          {view.name === "account" && <Account />}
        </main>
        <nav className="tabbar" aria-label="Main">
          <button aria-current={view.name === "groups" || view.name === "group"} onClick={() => go({ name: "groups" })}>
            <Icon d="M4 6h16M4 12h16M4 18h10" />Groups
          </button>
          <button aria-current={view.name === "friends"} onClick={() => go({ name: "friends" })}>
            <Icon d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8" />
            Friends{pendingInvites > 0 && <span className="badge">{pendingInvites}</span>}
          </button>
          <button aria-current={view.name === "account"} onClick={() => go({ name: "account" })}>
            <Icon d="M20 21v-1a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8" />Account
          </button>
        </nav>
        {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      </div>
    </AppCtx.Provider>
  );
}

export function Icon({ d }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
