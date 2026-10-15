// Kein Offline-Cache und keine Abfangen von Seitenaufrufen mehr: Hinter der zentralen Anmeldung
// (Weiterleitungen nach /.jms-auth/…) hat die frühere Fassung Seitenaufrufe über den Service Worker
// geleitet – in Safari blieb dann beim Öffnen von intercom.local ein weißer Bildschirm, bis man neu
// lud. Dieser Worker räumt die alten Zwischenspeicher weg und fängt nichts mehr ab.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
