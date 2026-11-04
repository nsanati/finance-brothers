import React, { useEffect, useState } from "react";
import { useApp } from "../App";
import { supabase, friendlyError } from "../lib/supabase";
import { pushSupported, currentSubscription, enablePush, disablePush, isIOS, isStandalone } from "../lib/push";
import { Avatar } from "../components/ui";

export default function Account() {
  const { me, setProfile, toast, session } = useApp();
  const [name, setName] = useState(me.display_name);
  const [pushOn, setPushOn] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { currentSubscription().then((s) => setPushOn(Boolean(s))).catch(() => setPushOn(false)); }, []);

  async function saveName(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const { data, error } = await supabase.from("profiles").update({ display_name: name.trim() }).eq("id", me.id).select().single();
    if (error) return toast(friendlyError(error));
    setProfile(data); toast("Name updated");
  }
  async function togglePush() {
    setBusy(true);
    try {
      if (pushOn) { await disablePush(); setPushOn(false); toast("Notifications off on this device"); }
      else { await enablePush(me.id); setPushOn(true); toast("Notifications on"); }
    } catch (e) { toast(friendlyError(e)); }
    setBusy(false);
  }

  const needsInstall = isIOS() && !isStandalone();

  return (
    <div className="stack">
      <header className="row-gap"><Avatar person={me} size={52} />
        <div><h1>{me.display_name}</h1><div className="muted">@{me.username} · {session.user.email}</div></div></header>

      <section className="stack-sm">
        <h2>Notifications</h2>
        <div className="card stack-sm">
          {needsInstall ? (
            <p className="muted">On iPhone, notifications only work once Split Tab is on your Home Screen. Tap the Share button in Safari, choose <b>Add to Home Screen</b>, then open Split Tab from there and come back here.</p>
          ) : !pushSupported() ? (
            <p className="muted">This browser can't receive notifications. Try Chrome, Edge or Firefox, or Safari on iPhone after adding the app to your Home Screen.</p>
          ) : (
            <>
              <p className="muted">Get a notification when a friend adds an expense you're part of, records a payment, or sends you an invite, plus a settle-up reminder at the end of each month.</p>
              <button className={"btn " + (pushOn ? "" : "primary")} onClick={togglePush} disabled={busy || pushOn === null}>
                {pushOn ? "Turn off on this device" : "Turn on notifications"}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="stack-sm">
        <h2>Profile</h2>
        <form className="row-form" onSubmit={saveName}>
          <label className="field grow"><span className="label">Name friends see</span>
            <input id="acc-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn">Save</button>
        </form>
      </section>

      {!isStandalone() && (
        <section className="stack-sm">
          <h2>Install the app</h2>
          <p className="muted small">On iPhone: Safari → Share → Add to Home Screen. On Android: Chrome menu → Install app. It then opens full-screen like any other app.</p>
        </section>
      )}

      <button className="btn" onClick={() => supabase.auth.signOut()}>Log out</button>
    </div>
  );
}
