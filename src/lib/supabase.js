import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createClient(url, key) : null;

/** Fire-and-forget: ask the server to notify the other people involved. */
export function notify(type, id) {
  if (!supabase) return;
  supabase.functions.invoke("notify", { body: { type, id } }).catch(() => {});
}

/** Turn Postgres / auth errors into sentences people can act on. */
export function friendlyError(err) {
  const m = (err && (err.message || err.error_description)) || String(err || "");
  if (/Invalid login credentials/i.test(m)) return "That email and password don't match. Check them and try again.";
  if (/Email not confirmed/i.test(m)) return "Confirm your email first. Check your inbox for the link we sent.";
  if (/already registered/i.test(m)) return "There's already an account with that email. Log in instead.";
  if (/Password should be/i.test(m)) return "Use a password with at least 6 characters.";
  if (/friendships_pair|duplicate key/i.test(m)) return "You already have an invite with this person.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "Can't reach the server. Check your connection and try again.";
  return m.replace(/^.*?exception:?\s*/i, "") || "Something went wrong. Try again.";
}
