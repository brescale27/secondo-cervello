// Secondo Cervello service worker.
//  - Offline: the app's own files are kept in a cache, so the web app opens without a connection.
//  - Cross-origin isolation: it adds COOP/COEP headers to the app's responses (static hosting cannot), which lets the
//    AI and voice engines use several CPU threads (SharedArrayBuffer).
//  - Models: files that sc_web.js stored in 64 MB parts are served whole at <scope>sc-model/<sha1>, the URL the AI
//    and voice engines open.
const SHELL = 'sc-shell-v3';

// Big files that never change at the same URL (pinned engine versions, fonts, bundled clips): cache first.
const STABLE = /\/(webgpu_bridge|ort|canvaskit|assets)\/|sqlite3\.wasm$|sqflite_sw\.js$/;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('sc-shell-') && key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

function isolate(response, path = '') {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') {
    return response;
  }
  const headers = new Headers(response.headers);
  // some static servers send .mjs as text/plain, and browsers refuse to import it as a module
  if (/\.m?js$/.test(path)) headers.set('Content-Type', 'text/javascript');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// A model file stored in 64 MB parts by sc_web.js, served whole as a stream: <scope>sc-model/<sha1>.
async function storedFile(hash) {
  const cache = await caches.open('sc-files-v1');
  const base = self.registration.scope + '__sc/' + hash + '/';
  const m = await cache.match(base + 'manifest');
  if (!m) return new Response('File non scaricato', { status: 404 });
  const { parts, size, type } = await m.json();
  let i = 0;
  let reader = null;
  const body = new ReadableStream({
    async pull(ctl) {
      for (;;) {
        if (!reader) {
          if (i >= parts) {
            ctl.close();
            return;
          }
          const part = await cache.match(base + i);
          if (!part) {
            ctl.error(new Error('Parte mancante ' + i));
            return;
          }
          reader = part.body.getReader();
          i++;
        }
        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        ctl.enqueue(value);
        return;
      }
    },
  });
  return isolate(new Response(body, { headers: { 'content-type': type, 'content-length': String(size) } }));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.endsWith('/sw.js')) return;
  const model = url.pathname.match(/\/sc-model\/([0-9a-f]{40})/);
  if (model) {
    event.respondWith(storedFile(model[1]));
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      if (STABLE.test(url.pathname)) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return isolate(hit, url.pathname);
      }
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return isolate(response, url.pathname);
      } catch (error) {
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return isolate(hit, url.pathname);
        throw error;
      }
    })(),
  );
});
