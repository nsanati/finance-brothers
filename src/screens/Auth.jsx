import React, { useEffect, useState } from "react";
import { supabase, friendlyError } from "../lib/supabase";

const redirectTo = () => location.origin + import.meta.env.BASE_URL;

export default function Auth() {
  const [mode, setMode] = useState("login"); // login | signup | forgot
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [userOk, setUserOk] = useState(null); // null unknown, true free, false taken
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  useEffect(() => {
    if (mode !== "signup" || !/^[a-z0-9_]{3,20}$/.test(username)) { setUserOk(null); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.rpc("username_available", { p_username: username });
      setUserOk(data);
    }, 350);
    return () => clearTimeout(t);
  }, [username, mode]);

  const switchTo = (m) => { setMode(m); setErr(""); setInfo(""); };

  async function submit(e) {
    e.preventDefault();
    setErr(""); setInfo(""); setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else if (mode === "signup") {
        if (!name.trim()) throw new Error("Enter your name so friends recognize you.");
        if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("Usernames are 3–20 lowercase letters, numbers or underscores.");
        if (userOk === false) throw new Error("That username is taken. Try another.");
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(), password,
          options: { data: { username, display_name: name.trim() }, emailRedirectTo: redirectTo() },
        });
        if (error) throw error;
        if (!data.session) { setInfo(`We sent a confirmation link to ${email.trim()}. Open it on this device, then log in.`); setMode("login"); }
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirectTo() });
        if (error) throw error;
        setInfo("If that email has an account, a reset link is on its way.");
      }
    } catch (e2) {
      setErr(friendlyError(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width="56" height="56" />
        <h1>Split Tab</h1>
        <p>Split the bill with friends. Settle up once a month.</p>
      </div>
      <form className="card auth-card" onSubmit={submit} noValidate>
        {mode !== "forgot" ? (
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => switchTo("login")}>Log in</button>
            <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => switchTo("signup")}>Sign up</button>
          </div>
        ) : <h2>Reset your password</h2>}

        {mode === "signup" && (
          <>
            <label className="field">
              <span className="label">Your name</span>
              <input id="su-name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Navid" />
            </label>
            <label className="field">
              <span className="label">Username</span>
              <div className="prefix-input"><span>@</span>
                <input id="su-user" autoCapitalize="none" autoCorrect="off" value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} maxLength={20} placeholder="navid" />
              </div>
              <span className={"hint " + (userOk === false ? "bad" : userOk ? "good" : "")}>
                {userOk === false ? "Taken. Try another." : userOk ? "Available." : "Friends can find you by this."}
              </span>
            </label>
          </>
        )}
        <label className="field">
          <span className="label">Email</span>
          <input id="au-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        {mode !== "forgot" && (
          <label className="field">
            <span className="label">Password</span>
            <input id="au-pass" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === "signup" ? "At least 6 characters" : ""} />
          </label>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        {info && <p className="info">{info}</p>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "One moment…" : mode === "login" ? "Log in" : mode === "signup" ? "Create account" : "Send reset link"}
        </button>
        {mode === "login" && <button type="button" className="btn link" onClick={() => switchTo("forgot")}>Forgot password?</button>}
        {mode === "forgot" && <button type="button" className="btn link" onClick={() => switchTo("login")}>Back to log in</button>}
      </form>
    </div>
  );
}

export function NewPassword({ onDone }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  async function submit(e) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) setErr(friendlyError(error)); else onDone();
  }
  return (
    <div className="auth">
      <form className="card auth-card" onSubmit={submit}>
        <h2>Choose a new password</h2>
        <label className="field"><span className="label">New password</span>
          <input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {err && <p className="error">{err}</p>}
        <button className="btn primary block">Save password</button>
      </form>
    </div>
  );
}
