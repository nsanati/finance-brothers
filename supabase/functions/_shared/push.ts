import webpush from "npm:web-push@3.6.7";
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/** Send a notification to every device the given users have turned notifications on for. */
export async function pushToUsers(db: SupabaseClient, userIds: string[], msg: PushMessage) {
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

export const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
