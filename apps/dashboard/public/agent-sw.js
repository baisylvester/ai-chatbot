// Service worker for mail agent notifications. Pushes arrive empty: the text is fetched here with the
// signed-in user's own session, so mail content never travels through a push service.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let items = [];
    try {
      const response = await fetch("/api/agent/notifications", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) items = (await response.json()).items || [];
    } catch {
      // Offline or signed out: fall through to the generic notice below.
    }
    // Browsers require a visible notification for every push.
    if (!items.length) items = [{ id: "mail-agent", title: "Mail agent", body: "You have new mail. Open the app to see what needs attention." }];
    for (const item of items) {
      await self.registration.showNotification(String(item.title), {
        body: String(item.body), icon: "/icon.svg", badge: "/icon.svg", tag: String(item.id), data: { url: "/agent" },
      });
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname.startsWith("/agent")) return client.focus();
    }
    return self.clients.openWindow("/agent");
  })());
});
