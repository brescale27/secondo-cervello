// Browser helpers for the Secondo Cervello web app.
//
// Model files (AI and voices) are downloaded once into Cache Storage, persistent for a web app added to the Home
// Screen, then work offline. Browsers limit the size of a single cache entry (some refuse ~300 MB), so every file is
// stored in 64 MB parts plus a small manifest, under <app>/__sc/<sha1 of its URL>/. The service worker (sw.js) serves
// a stored file whole at <app>/sc-model/<sha1>/<file name>, which is the URL the engines open.
(function () {
  const FILES = 'sc-files-v1';
  const PART = 64 * 1024 * 1024;
  let controller = null;

  const keyOf = (url) => new URL(url, window.location.href).toString();
  const store = () => new URL('__sc/', document.baseURI).href;

  async function hashOf(key) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(keyOf(key)));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function manifest(key) {
    const cache = await caches.open(FILES);
    const hash = await hashOf(key);
    const r = await cache.match(store() + hash + '/manifest');
    return r ? { cache, hash, m: await r.json() } : null;
  }

  async function removeParts(cache, hash, parts) {
    for (let i = 0; i < parts; i++) await cache.delete(store() + hash + '/' + i);
    await cache.delete(store() + hash + '/manifest');
  }

  window.scStore = {
    async has(key) {
      return !!(await manifest(key));
    },

    async size(key) {
      const f = await manifest(key);
      return f ? f.m.size : 0;
    },

    async remove(key) {
      const f = await manifest(key);
      if (f) await removeParts(f.cache, f.hash, f.m.parts);
    },

    async readText(key) {
      const f = await manifest(key);
      if (!f) throw new Error('File non scaricato: ' + key);
      const blobs = [];
      for (let i = 0; i < f.m.parts; i++) blobs.push(await (await f.cache.match(store() + f.hash + '/' + i)).blob());
      return await new Blob(blobs).text();
    },

    // The same-origin URL the service worker serves the stored file from; it ends with the original file name, so the
    // engines recognise the format (.gguf, .onnx) as they would from the download URL.
    async localUrl(key) {
      const name = new URL(keyOf(key)).pathname.split('/').pop() || 'file';
      return new URL('sc-model/' + (await hashOf(key)) + '/' + name, document.baseURI).href;
    },

    // Downloads the first mirror that answers, writing 64 MB parts as the bytes arrive (never the whole file in memory).
    async download(urls, key, expected, onProgress) {
      controller = new AbortController();
      const cache = await caches.open(FILES);
      const hash = await hashOf(key);
      let lastError = null;
      for (const url of urls) {
        let parts = 0;
        try {
          const res = await fetch(url, { signal: controller.signal, mode: 'cors' });
          if (!res.ok || !res.body) throw new Error('Il server ha risposto ' + res.status);
          const reader = res.body.getReader();
          let received = 0, last = 0, buffered = [], bufferedBytes = 0;
          const flush = async () => {
            if (bufferedBytes === 0) return;
            await cache.put(store() + hash + '/' + parts, new Response(new Blob(buffered)));
            parts++;
            buffered = [];
            bufferedBytes = 0;
          };
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffered.push(value);
            bufferedBytes += value.byteLength;
            received += value.byteLength;
            if (bufferedBytes >= PART) await flush();
            const now = Date.now();
            if (now - last > 250) {
              last = now;
              onProgress(received);
            }
          }
          await flush();
          onProgress(received);
          if (expected > 0 && received !== expected) throw new Error('File incompleto');
          const type = res.headers.get('content-type') || 'application/octet-stream';
          await cache.put(store() + hash + '/manifest', new Response(JSON.stringify({ parts, size: received, type, key: keyOf(key) }),
            { headers: { 'content-type': 'application/json' } }));
          return received;
        } catch (e) {
          await removeParts(cache, hash, parts + 1);
          if (controller.signal.aborted) throw new Error('Download annullato');
          lastError = e;
        }
      }
      throw lastError || new Error('Download non riuscito');
    },

    abort() {
      if (controller) controller.abort();
    },

    async persist() {
      try {
        if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
      } catch (_) {}
      return false;
    },
  };

  // Audio for the web app through Web Audio: Safari only lets sound start from a tap, and the voice arrives seconds
  // later, so the audio context is unlocked on the first tap and then plays everything (voice, background, bell).
  // The audio session is set to "playback", so it is heard even with the iPhone's silent switch on, like an app.
  window.scAudio = (function () {
    let ctx = null;
    const nodes = {};

    function context() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx;
    }

    function unlock() {
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (_) {}
      const c = context();
      if (c.state !== 'running') c.resume().catch(() => {});
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start(0);
      try {
        if (window.speechSynthesis && !window.__scTtsUnlocked) {
          window.__scTtsUnlocked = true;
          window.speechSynthesis.speak(new SpeechSynthesisUtterance(''));
        }
      } catch (_) {}
    }
    ['touchend', 'pointerup', 'click', 'keydown'].forEach((ev) =>
      document.addEventListener(ev, unlock, { capture: true, passive: true }));

    function stop(name) {
      const n = nodes[name];
      if (!n) return;
      delete nodes[name];
      try {
        n.src.onended = null;
        n.src.stop();
      } catch (_) {}
      n.resolve();
    }

    return {
      // Plays WAV bytes on channel [name] (one sound per channel); resolves with the duration in seconds.
      async play(name, bytes, volume, loop) {
        stop(name);
        const c = context();
        if (c.state !== 'running') await c.resume().catch(() => {});
        const buffer = await c.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        const src = c.createBufferSource();
        src.buffer = buffer;
        src.loop = !!loop;
        const gain = c.createGain();
        gain.gain.value = volume;
        src.connect(gain).connect(c.destination);
        let resolve;
        const done = new Promise((r) => (resolve = r));
        const node = { src, gain, done, resolve };
        src.onended = () => {
          if (nodes[name] === node) delete nodes[name];
          resolve();
        };
        nodes[name] = node;
        src.start();
        return buffer.duration;
      },
      // Resolves when the sound on [name] ends or is stopped.
      wait(name) {
        return nodes[name] ? nodes[name].done : Promise.resolve();
      },
      stop,
      volume(name, v) {
        const n = nodes[name];
        if (n) n.gain.gain.setTargetAtTime(v, context().currentTime, 0.05);
      },
      async fade(name, seconds) {
        const n = nodes[name];
        if (!n) return;
        n.gain.gain.setTargetAtTime(0, context().currentTime, seconds / 4);
        await new Promise((r) => setTimeout(r, seconds * 1000));
        stop(name);
      },
    };
  })();

  // iPhone: motion sensors (night mode) need an explicit permission asked from a tap.
  window.scRequestMotion = async function () {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        return (await DeviceMotionEvent.requestPermission()) === 'granted';
      }
    } catch (_) {
      return false;
    }
    return true;
  };

  window.scDeviceMemory = function () {
    return navigator.deviceMemory || 0;
  };

  window.scIsStandalone = function () {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  };
})();
