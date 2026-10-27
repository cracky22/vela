// Vela Service Worker: zeigt Push-Benachrichtigungen an (auch bei geschlossener App) und Android-taugliche
// Benachrichtigungen. Kein Offline-Cache, kein Abfangen von Anfragen.
// Der Push enthält nie Nachrichteninhalt, nur „Neue Nachricht von …“.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.visibilityState === 'visible')) return;   // Nutzer schaut gerade in die App
    const scope = self.registration.scope;
    await self.registration.showNotification(d.title || 'Vela', {
      body: d.body || 'Neue Nachricht',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: scope + 'static/icon-192.png',
      badge: scope + 'static/badge-96.png',
      data: { conv: d.tag || null },
      timestamp: Date.now(),
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conv = event.notification.data && event.notification.data.conv;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      try { await w.focus(); } catch { /* ok */ }
      if (conv) w.postMessage({ type: 'open-chat', conv });
      return;
    }
    await self.clients.openWindow(self.registration.scope);
  })());
});