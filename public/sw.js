// Split Tab service worker: shows push notifications and opens the app when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = { title: "Split Tab", body: "Something changed in your group." };
  try { msg = { ...msg, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      icon: "icon-192.png",
      badge: "icon-192.png",
      data: { url: new URL(msg.url || "./", self.registration.scope).href },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.startsWith(self.registration.scope)) { w.navigate(url); return w.focus(); }
      }
      return self.clients.openWindow(url);
    }),
  );
});
