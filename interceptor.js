/**
 * Eilatan Lingo — interceptor (MAIN world).
 *
 * Runs inside the page's own JavaScript world, so it can wrap window.fetch,
 * XMLHttpRequest and form submission before the site's code ever touches the
 * wire. Any English you type that leaves the page — form submit, fetch, XHR,
 * beacon — is translated to the site's auto-detected language on the way OUT.
 * What you see on screen never changes.
 *
 * It cannot use chrome.runtime directly, so it shouts into the DOM via
 * postMessage and the isolated-world content script (content.js) relays to the
 * background worker and shouts the translated text back.
 *
 * Safety philosophy: false-negatives (leaving a string English) are always
 * better than false-positives (mangling a token/id/secret). Detection gating
 * means only strings that Google actually identifies as English get replaced.
 */

(() => {
  if (window.__eilatanLingoInterceptor) return;
  window.__eilatanLingoInterceptor = true;

  // -------------------------------------------------------------------------
  // Bridge to the isolated world
  // -------------------------------------------------------------------------
  const PENDING = new Map();
  let msgId = 0;

  function interactionOn() {
    return document.documentElement.dataset.etrInteraction === '1';
  }
  function siteLang() {
    return document.documentElement.dataset.etrSiteLang || '';
  }
  function isTranslateUrl(url) {
    if (!url) return false;
    const u = String(url);
    if (/^data:/i.test(u) || /^blob:/i.test(u) || /^chrome-extension:/i.test(u)) return true;
    return /translate\.(googleapis|google)\.com|googleapis\.com\/translate_/i.test(u);
  }

  function translateBatch(texts, target, autodetect, mode) {
    return new Promise((resolve) => {
      const id = ++msgId;
      PENDING.set(id, resolve);
      window.postMessage(
        { source: 'etr-lingo-main', type: 'translate-batch', id, texts, target, autodetect, mode: mode || 'out' },
        '*'
      );
      setTimeout(() => {
        if (PENDING.has(id)) {
          PENDING.delete(id);
          resolve(null);
        }
      }, 20000);
    });
  }

  function resolveTarget() {
    return new Promise((resolve) => {
      const id = ++msgId;
      PENDING.set(id, resolve);
      window.postMessage({ source: 'etr-lingo-main', type: 'resolve-target', id }, '*');
      setTimeout(() => {
        if (PENDING.has(id)) {
          PENDING.delete(id);
          resolve({ target: '' });
        }
      }, 15000);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'etr-lingo-isolated' || d.id == null) return;
    const resolve = PENDING.get(d.id);
    if (resolve) {
      PENDING.delete(d.id);
      resolve(d);
    }
  });

  // Local sync cache of already-translated strings (for beacon + fast paths).
  const syncCache = new Map(); // original -> { tx, det }
  function rememberSync(original, it) {
    if (syncCache.size >= 500) {
      const oldest = syncCache.keys().next().value;
      if (oldest !== undefined) syncCache.delete(oldest);
    }
    syncCache.set(original, it);
  }

  // -------------------------------------------------------------------------
  // Heuristics
  // -------------------------------------------------------------------------
  const SENSITIVE_KEY = new RegExp(
    '^(id|ids?|.*_?id|token|tokens?|.*_?token|.*_?key|.*_?secret|password|passwd|pwd|.*_?password|' +
    'email|emails?|.*_?email|url|uri|href|.*_?url|.*_?uri|.*_?link|phone|phones?|.*_?phone|uuid|guid|' +
    '.*_?uuid|.*_?guid|hash|hashes?|.*_?hash|nonce|.*_?nonce|auth|authorization|.*_?auth|session|' +
    '.*_?session|cookie|cookies?|.*_?cookie|client_?id|client_?secret|api_?key|access_?token|' +
    'refresh_?token|signature|.*_?signature|digest|captcha|.*_?captcha|g-recaptcha-response|csrf|.*_?csrf|' +
    'xsrf|.*_?xsrf|otp|mfa|2fa|pin|.*_?pin|.*_?security|fingerprint|.*_?fingerprint|ip|.*_?ip|host|' +
    'hostname|.*_?host|domain|.*_?domain|user_?agent|.*_?ua|b64|base64|.*_?encoded|.*_?encrypted|salt|' +
    '.*_?salt|iv|file|files?|.*_?file|.*_?filename|.*_?path|.*_?avatar|.*_?icon|.*_?image|.*_?photo|' +
    '.*_?picture|.*_?logo|.*_?thumbnail|.*_?attachment|file_?name|filename)$',
    'i'
  );

  const CONTENT_KEY = new RegExp(
    '^(message|messages?|msg|msgs?|text|txt|content|body|comment|comments?|reply|replies?|question|questions?|' +
    'answer|answers?|response|responses?|description|desc|summary|detail|details?|note|notes?|bio|about|intro|' +
    'headline|heading|subtitle|title|subject|topic|thread|post|posts?|tweet|tweets?|status|update|updates?|' +
    'prompt|query|q|search|term|terms?|keyword|keywords?|tags?|chat|talk|speech|sentence|sentences?|paragraph|' +
    'review|reviews?|feedback|quote|quotes?|statement|story|news|caption|captions?|overview|name|full_?name|' +
    'first_?name|last_?name|given_?name|family_?name|nickname|nick|display_?name|screen_?name|real_?name|' +
    'user_?name|username|login|handle|alias|label|field_?label|aria_?label|placeholder|hint|hint_?text|tooltip|' +
    'alt|alt_?text|button_?text|link_?text|menu_?item|tab_?label|section|header|footer|tagline|slogan|motto|' +
    'say|speak|write|typed|input|typed_?text|user_?input|message_?text|body_?text|content_?text)$',
    'i'
  );

  function isTokenLike(s) {
    if (typeof s !== 'string' || !s) return true;
    if (s.length < 2 || s.length > 2000) return true;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) return true; // binary junk
    if (/^[\d\s.,+\-*\/%=<>()\[\]]+$/.test(s)) return true; // numeric-ish
    if (/^https?:\/\//i.test(s) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return true;
    if (/^(eyJ[\w-]*\.){2}/.test(s)) return true; // JWT
    return false;
  }

  function looksEnglish(s) {
    if (isTokenLike(s)) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    const nonLatin = (s.match(/[^\u0000-\u024F\u2000-\u206F\s.,!?;:'"()\[\]{}@#$%^&*+=<>/\\|~`_\-\u2010-\u2015\u2018\u2019\u201C\u201D\u2026]/g) || []).length;
    return nonLatin / s.length < 0.35;
  }

  // Outgoing gate: English prose we're willing to touch. Short single words are
  // usually protocol commands ("ping", "ack", "ready") — leave them alone unless
  // the key says it's user content.
  function isOutgoingValue(v, key) {
    if (!looksEnglish(v)) return false;
    if (v.includes(' ') || v.length >= 24) return true;
    return CONTENT_KEY.test(key || '');
  }

  // Incoming gate: any natural-language prose that ISN'T already English.
  // The detection gate below decides the rest.
  function isIncomingProse(s) {
    if (isTokenLike(s)) return false;
    if (!/\p{L}/u.test(s)) return false;
    const hasNonLatin = /[^\u0000-\u024F]/.test(s);
    return hasNonLatin || s.includes(' ') || s.length >= 24;
  }

  // -------------------------------------------------------------------------
  // Candidate collection + translation application
  // -------------------------------------------------------------------------
  function collectCandidates() {
    return {
      items: [],          // { obj, key, value } — JSON walk results
      params: [],         // [ [paramsObj, name], ... ]
      formData: [],       // [ [fd, name], ... ]
    };
  }

  function walkStrings(obj, c, predicate) {
    if (obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const v of obj) walkStrings(v, c, predicate);
      return;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (SENSITIVE_KEY.test(k)) continue;
        if (!predicate || predicate(v, k)) c.items.push({ obj, key: k, value: v });
      } else if (v && typeof v === 'object') {
        walkStrings(v, c, predicate);
      }
    }
  }

  async function applyTranslations(items, target, autodetect, mode) {
    // Dedupe by value.
    const unique = [];
    const seen = new Set();
    for (const it of items) {
      if (!seen.has(it.value)) { seen.add(it.value); unique.push(it.value); }
    }
    if (!unique.length) return false;

    const resp = await translateBatch(unique, target, autodetect, mode || 'out');
    if (!resp || !Array.isArray(resp.items)) return false;

    const map = new Map();
    resp.items.forEach((it, i) => {
      if (!it || !it.tx || it.tx === unique[i]) return;
      const ok = mode === 'in'
        ? it.det && it.det !== 'en'
        : it.det === 'en';
      if (ok) {
        map.set(unique[i], it.tx);
        rememberSync(unique[i], it);
      }
    });
    if (!map.size) return false;

    for (const it of items) {
      const tx = map.get(it.value);
      if (tx !== undefined) it.obj[it.key] = tx;
    }
    return true;
  }

  async function translateParams(params) {
    const entries = [];
    for (const [name, value] of params.entries()) {
      if (SENSITIVE_KEY.test(name)) continue;
      if (typeof value === 'string' && isOutgoingValue(value, name)) entries.push([name, value]);
    }
    if (!entries.length) return false;
    const unique = [...new Set(entries.map(([, v]) => v))];
    const resp = await translateBatch(unique, siteLang() || '', !siteLang());
    if (!resp || !Array.isArray(resp.items)) return false;
    let changed = false;
    const map = new Map();
    resp.items.forEach((it, i) => {
      if (it && it.det === 'en' && it.tx && it.tx !== unique[i]) { map.set(unique[i], it.tx); rememberSync(unique[i], it); }
    });
    if (!map.size) return false;
    for (const [name, value] of entries) {
      const tx = map.get(value);
      if (tx !== undefined) { params.set(name, tx); changed = true; }
    }
    return changed;
  }

  async function translateFormData(fd) {
    const entries = [];
    for (const [name, value] of fd.entries()) {
      if (typeof value !== 'string') continue;
      if (SENSITIVE_KEY.test(name)) continue;
      if (isOutgoingValue(value, name)) entries.push([name, value]);
    }
    if (!entries.length) return false;
    const unique = [...new Set(entries.map(([, v]) => v))];
    const resp = await translateBatch(unique, siteLang() || '', !siteLang());
    if (!resp || !Array.isArray(resp.items)) return false;
    let changed = false;
    const map = new Map();
    resp.items.forEach((it, i) => {
      if (it && it.det === 'en' && it.tx && it.tx !== unique[i]) { map.set(unique[i], it.tx); rememberSync(unique[i], it); }
    });
    if (!map.size) return false;
    for (const [name, value] of entries) {
      const tx = map.get(value);
      if (tx !== undefined) { fd.set(name, tx); changed = true; }
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Body processing
  // -------------------------------------------------------------------------
  function canProcess(ct) {
    if (!ct) return true;
    return !/(octet-stream|image\/|audio\/|video\/|font\/|pdf|zip|gzip|compressed|protobuf|grpc|multipart\/mixed|javascript|xhtml)/i.test(ct);
  }

  function headerContentType(headers) {
    try {
      if (headers instanceof Headers) return headers.get('content-type') || '';
      if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === 'content-type') return String(headers[k]);
        }
      }
    } catch {}
    return '';
  }

  async function maybeTranslateTextBody(text, ct) {
    if (!text || !canProcess(ct)) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;

    if (ct.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let obj;
      try { obj = JSON.parse(text); } catch { return null; }
      const c = collectCandidates();
      walkStrings(obj, c, isOutgoingValue);
      const changed = await applyTranslations(c.items, siteLang() || '', !siteLang(), 'out');
      if (!changed) return null;
      return { changed: true, body: JSON.stringify(obj) };
    }

    if (ct.includes('x-www-form-urlencoded') || (trimmed.includes('=') && !trimmed.includes('<'))) {
      try {
        const params = new URLSearchParams(text);
        const changed = await translateParams(params);
        if (!changed) return null;
        return { changed: true, body: params.toString() };
      } catch { return null; }
    }

    if (!ct || ct.includes('text/')) {
      // Whole body is user prose (e.g. a text/plain chat message).
      if (!looksEnglish(text) || text.length > 2000) return null;
      if (!text.includes(' ') && text.length < 24) return null; // protocol token, not prose
      const resp = await translateBatch([text], siteLang() || '', !siteLang());
      if (!resp || !resp.items || !resp.items[0]) return null;
      const it = resp.items[0];
      if (it.det !== 'en' || !it.tx || it.tx === text) return null;
      rememberSync(text, it);
      return { changed: true, body: it.tx };
    }
    return null;
  }

  async function maybeTranslateBody(body, headers) {
    if (body == null) return null;
    const ct = headerContentType(headers);

    if (typeof body === 'string') return maybeTranslateTextBody(body, ct);

    if (body instanceof URLSearchParams) {
      const changed = await translateParams(body);
      return changed ? { changed: true, body } : null;
    }

    if (body instanceof FormData) {
      const changed = await translateFormData(body);
      return changed ? { changed: true, body } : null;
    }

    if (body instanceof Blob) {
      const bct = body.type || ct || '';
      if (!canProcess(bct)) return null;
      const text = await body.text();
      const p = await maybeTranslateTextBody(text, bct);
      if (p && p.changed) return { changed: true, body: new Blob([p.body], { type: bct || 'text/plain' }) };
      return null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // fetch() interception
  // -------------------------------------------------------------------------
  let lastSend = 0; // used by the form handler to avoid double-submission
  function noteSend() { lastSend = Date.now(); }

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    init = init || {};
    const req = input instanceof Request ? input : null;
    const method = (init.method || (req ? req.method : null) || 'GET').toUpperCase();
    const url = init.url || (req ? req.url : (typeof input === 'string' ? input : (input && input.url) || ''));

    if (interactionOn() && ['POST', 'PUT', 'PATCH'].includes(method) && !isTranslateUrl(url)) {
      try {
        // Case 1: body lives on a Request object.
        if (req && init.body === undefined) {
          const rct = req.headers.get('content-type') || '';
          if (canProcess(rct) && (rct.includes('json') || rct.includes('text/') || rct.includes('urlencoded'))) {
            const clone = req.clone();
            const text = await clone.text();
            const p = await maybeTranslateTextBody(text, rct);
            if (p && p.changed) {
              noteSend();
              const headers = new Headers(init.headers || req.headers);
              return origFetch.call(this, url, {
                ...pickRequestProps(req),
                method,
                headers,
                body: p.body,
              });
            }
          }
          return origFetch.call(this, input, init);
        }

        // Case 2: body in init.
        const p = await maybeTranslateBody(init.body, init.headers);
        if (p && p.changed) {
          noteSend();
          return origFetch.call(this, input, { ...init, body: p.body });
        }
      } catch {}
    }
    return origFetch.call(this, input, init);
  };

  function pickRequestProps(req) {
    return {
      credentials: req.credentials,
      cache: req.cache,
      mode: req.mode,
      redirect: req.redirect,
      referrer: req.referrer,
      referrerPolicy: req.referrerPolicy,
      integrity: req.integrity,
      keepalive: req.keepalive,
      signal: req.signal,
    };
  }

  // -------------------------------------------------------------------------
  // XMLHttpRequest interception
  // -------------------------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
    this._etrMethod = String(method || 'GET').toUpperCase();
    this._etrUrl = String(url || '');
    return origOpen.call(this, method, url, async, user, pass);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = async function (body) {
    const method = this._etrMethod || 'GET';
    const url = this._etrUrl || '';
    if (interactionOn() && ['POST', 'PUT', 'PATCH'].includes(method) && !isTranslateUrl(url)) {
      try {
        let ct = '';
        try { ct = this.getRequestHeader('Content-Type') || ''; } catch {}
        const p = await maybeTranslateBody(body, ct);
        if (p && p.changed) {
          noteSend();
          body = p.body;
        }
      } catch {}
    }
    return origSend.call(this, body);
  };

  // -------------------------------------------------------------------------
  // navigator.sendBeacon (cache-only: it must be fire-and-forget)
  // -------------------------------------------------------------------------
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (interactionOn() && !isTranslateUrl(url) && typeof data === 'string') {
        const hit = syncCache.get(data);
        if (hit && hit.det === 'en' && hit.tx) data = hit.tx;
      }
      return origBeacon(url, data);
    };
  }

  // -------------------------------------------------------------------------
  // Form submission — native forms don't go through fetch/XHR, so translate a
  // hidden clone and submit THAT. Visible form stays English.
  // Backoff guard: if the page's own JS sends a request within 150ms of the
  // submit event (preventDefault + fetch pattern), our fetch wrapper already
  // translated it — so we stand down instead of double-submitting.
  // -------------------------------------------------------------------------
  function collectFormCandidates(form) {
    const out = [];
    for (const el of form.elements) {
      if (!(el instanceof HTMLInputElement) || !(el instanceof HTMLTextAreaElement)) {
        if (!(el instanceof HTMLSelectElement)) continue;
      }
      if (el.disabled) continue;
      const type = (el.type || '').toLowerCase();
      if (['submit', 'button', 'file', 'checkbox', 'radio', 'hidden', 'password', 'reset', 'image', 'range', 'color'].includes(type)) continue;
      const name = el.name || el.id;
      if (!name || SENSITIVE_KEY.test(name)) continue;
      const value = (typeof el.value === 'string' ? el.value : '') || '';
      if (isOutgoingValue(value, name)) out.push({ name, value });
    }
    return out;
  }

  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (form.dataset.etrHandled === '1') return;
      if (!interactionOn()) return;

      const candidates = collectFormCandidates(form);
      if (!candidates.length) return;

      e.preventDefault();
      form.dataset.etrHandled = '1';

      (async () => {
        try {
          // Autodetect self-heal: if the site language isn't known yet, sniff
          // it now — never silently skip an interaction.
          let target = siteLang();
          if (!target) {
            const r = await resolveTarget();
            target = (r && r.target) || '';
          }
          if (!target || target === 'en') return;

          const unique = [...new Set(candidates.map((c) => c.value))];
          const resp = await translateBatch(unique, target, false);
          if (!resp || !Array.isArray(resp.items)) return;

          // If the page's own code fired off a request since the event
          // (typical JS-handled form), back off — it's already translated.
          if (Date.now() - lastSend < 150) return;

          const map = new Map();
          resp.items.forEach((it, i) => {
            if (it && it.det === 'en' && it.tx && it.tx !== unique[i]) map.set(unique[i], it.tx);
          });
          if (!map.size) return;

          const clone = form.cloneNode(true);
          clone.dataset.etrHandled = '1';
          clone.style.position = 'absolute';
          clone.style.left = '-9999px';
          clone.style.top = '0';
          clone.style.width = '1px';
          clone.style.height = '1px';
          clone.style.visibility = 'hidden';
          clone.style.pointerEvents = 'none';
          document.body.appendChild(clone);

          for (const c of candidates) {
            const tx = map.get(c.value);
            if (tx === undefined) continue;
            let target = null;
            try { target = clone.elements.namedItem(c.name); } catch {}
            if (!target && c.name) target = clone.querySelector(`[name="${CSS.escape(c.name)}"]`);
            if (!target) continue;
            if (target instanceof RadioNodeList) { target.value = tx; }
            else if (typeof target.value === 'string') { target.value = tx; }
          }

          clone.submit();
          setTimeout(() => { if (clone.parentNode) clone.parentNode.removeChild(clone); }, 500);
        } finally {
          delete form.dataset.etrHandled;
        }
      })();
    },
    true
  );

  // -------------------------------------------------------------------------
  // WebSocket layer.
  //
  // OUTGOING:  your English frames → site language, order-preserving.
  // INCOMING:  site-language frames → your display language (canvas chats
  //            that never touch the DOM, for example). Gated on pageOn.
  //
  // Frames that aren't prose — binary, protocol tokens like "ping"/"ack",
  // numeric payloads — pass through untouched. Detection gating protects the
  // rest: a string is only replaced when Google actually identifies it as
  // being in the wrong language for its direction.
  // -------------------------------------------------------------------------
  function pageOn() {
    return document.documentElement.dataset.etrPageOn === '1';
  }

  // --- incoming: message listener wrapping --------------------------------
  const listenerProxyMaps = new WeakMap(); // listener -> WeakMap<socket, proxy>
  const proxySentinel = true; // lives on proxy functions as .__etrProxy

  function proxyFor(ws, listener) {
    let perSocket = listenerProxyMaps.get(listener);
    if (!perSocket) {
      perSocket = new WeakMap();
      listenerProxyMaps.set(listener, perSocket);
    }
    let proxy = perSocket.get(ws);
    if (!proxy) {
      proxy = function etrWsProxy(event) {
        const data = event.data;
        const self = this;
        if (!pageOn() || (typeof data !== 'string' && !(data instanceof Blob))) {
          return listener.call(self, event);
        }
        if (typeof data === 'string') {
          if (data.length < 2) return listener.call(self, event);
          queueIncoming(self, listener, event);
        } else {
          queueIncomingBlob(self, listener, event);
        }
      };
      proxy.__etrProxy = proxySentinel;
      perSocket.set(ws, proxy);
    }
    return proxy;
  }

  const ORIG_WS_ADD = WebSocket.prototype.addEventListener;
  const ORIG_WS_REMOVE = WebSocket.prototype.removeEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type === 'message' && typeof listener === 'function' && !listener.__etrProxy) {
      listener = proxyFor(this, listener);
    }
    return ORIG_WS_ADD.call(this, type, listener, options);
  };
  WebSocket.prototype.removeEventListener = function (type, listener, options) {
    if (type === 'message' && typeof listener === 'function') {
      const perSocket = listenerProxyMaps.get(listener);
      if (perSocket && perSocket.has(this)) listener = perSocket.get(this);
    }
    return ORIG_WS_REMOVE.call(this, type, listener, options);
  };

  const ORIG_ONMSG = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  if (ORIG_ONMSG && ORIG_ONMSG.get) {
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      get() { return ORIG_ONMSG.get.call(this); },
      set(fn) {
        if (typeof fn === 'function' && !fn.__etrProxy) fn = proxyFor(this, fn);
        return ORIG_ONMSG.set.call(this, fn);
      },
      configurable: true,
    });
  }

  // --- incoming: batching + dispatch --------------------------------------
  let incomingBatch = [];
  let incomingTimer = null;

  function queueIncoming(ws, listener, event) {
    incomingBatch.push({ listener, ws, event, data: event.data });
    if (!incomingTimer) incomingTimer = setTimeout(flushIncoming, 25);
  }

  function queueIncomingBlob(ws, listener, event) {
    const blob = event.data;
    if (blob.type && !/(json|text|javascript|xml)/i.test(blob.type)) {
      return listener.call(ws, event);
    }
    blob
      .text()
      .then(async (text) => {
        if (!text || text.length < 2) return listener.call(ws, event);
        let out = text;
        try {
          const t = await translateIncomingText(text);
          if (t != null) out = t;
        } catch {}
        try {
          Object.defineProperty(event, 'data', { value: new Blob([out], { type: blob.type || 'text/plain' }), configurable: true, writable: true });
        } catch {}
        listener.call(ws, event);
      })
      .catch(() => listener.call(ws, event));
  }

  async function translateIncomingText(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const obj = JSON.parse(text);
        const c = collectCandidates();
        walkStrings(obj, c, isIncomingProse);
        const changed = await applyTranslations(c.items, '', true, 'in');
        return changed ? JSON.stringify(obj) : null;
      } catch { /* not JSON after all — fall through */ }
    }
    if (looksEnglish(text)) return null; // already English
    if (!isIncomingProse(text)) return null;
    const resp = await translateBatch([text], '', true, 'in');
    if (!resp || !resp.items || !resp.items[0]) return null;
    const it = resp.items[0];
    if (!it.det || it.det === 'en' || !it.tx || it.tx === text) return null;
    rememberSync(text, it);
    return it.tx;
  }

  async function flushIncoming() {
    incomingTimer = null;
    const batch = incomingBatch;
    incomingBatch = [];
    if (!batch.length) return;

    // JSON frames get parsed and walked (only values translated, structure
    // preserved). Plain frames ride one batched request.
    const jsonOut = new Map();
    const plainEntries = [];

    await Promise.all(batch.map(async (b) => {
      const trimmed = b.data.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const t = await translateIncomingText(b.data);
          if (t != null) jsonOut.set(b.data, t);
        } catch {}
      } else {
        plainEntries.push(b);
      }
    }));

    const plainOut = new Map();
    if (plainEntries.length) {
      const unique = [...new Set(plainEntries.map((b) => b.data))];
      let resp = null;
      try { resp = await translateBatch(unique, '', true, 'in'); } catch {}
      if (resp && Array.isArray(resp.items)) {
        unique.forEach((u, i) => {
          const it = resp.items[i];
          if (it && it.det && it.det !== 'en' && it.tx && it.tx !== u) plainOut.set(u, it.tx);
        });
      }
    }

    for (const b of batch) {
      let out = b.data;
      if (jsonOut.has(b.data)) out = jsonOut.get(b.data);
      else if (plainOut.has(b.data)) out = plainOut.get(b.data);

      let ev = b.event;
      if (out !== b.data) {
        try {
          Object.defineProperty(ev, 'data', { value: out, configurable: true, writable: true });
        } catch {
          try {
            ev = new MessageEvent('message', {
              data: out,
              origin: b.event.origin,
              lastEventId: b.event.lastEventId,
              source: b.event.source,
              ports: b.event.ports,
            });
          } catch { ev = b.event; }
        }
      }
      try { b.listener.call(b.ws, ev); } catch (err) { setTimeout(() => { throw err; }); }
    }
  }

  // --- outgoing: WebSocket.send -------------------------------------------
  const origWsSend = WebSocket.prototype.send;

  async function sendWsTranslated(ws, data) {
    let out = data;
    try {
      const t = await translateOutgoingWsText(data);
      if (t != null) out = t;
    } catch {}
    try { origWsSend.call(ws, out); } catch {}
  }

  async function translateOutgoingWsText(data) {
    if (!data) return null;
    const trimmed = data.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let obj;
      try { obj = JSON.parse(data); } catch { obj = null; }
      if (obj) {
        const c = collectCandidates();
        walkStrings(obj, c, isOutgoingValue);
        const changed = await applyTranslations(c.items, siteLang() || '', !siteLang(), 'out');
        return changed ? JSON.stringify(obj) : null;
      }
    }
    if (!looksEnglish(data) || data.length > 2000) return null;
    if (!data.includes(' ') && data.length < 24) return null; // protocol token
    const hit = syncCache.get(data);
    if (hit) return hit.det === 'en' && hit.tx && hit.tx !== data ? hit.tx : null;
    const resp = await translateBatch([data], siteLang() || '', !siteLang());
    if (!resp || !resp.items || !resp.items[0]) return null;
    const it = resp.items[0];
    if (it.det !== 'en' || !it.tx || it.tx === data) return null;
    rememberSync(data, it);
    return it.tx;
  }

  WebSocket.prototype.send = function (data) {
    if (interactionOn() && typeof data === 'string') {
      const ws = this;
      if (!ws.__etrChain) {
        Object.defineProperty(ws, '__etrChain', { value: Promise.resolve(), writable: true, configurable: true });
      }
      // Per-socket FIFO so translated frames leave in the order they were sent.
      ws.__etrChain = ws.__etrChain.then(() => sendWsTranslated(ws, data));
      return;
    }
    return origWsSend.call(this, data);
  };
})();
