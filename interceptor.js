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

  function translateBatch(texts, target, autodetect) {
    return new Promise((resolve) => {
      const id = ++msgId;
      PENDING.set(id, resolve);
      window.postMessage(
        { source: 'etr-lingo-main', type: 'translate-batch', id, texts, target, autodetect },
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

  function looksEnglish(s) {
    if (typeof s !== 'string' || !s) return false;
    if (s.length < 2 || s.length > 2000) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s)) return false; // binary junk
    if (/^[\d\s.,+\-*\/%=<>()\[\]]+$/.test(s)) return false; // numeric-ish
    if (/^https?:\/\//i.test(s) || /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s)) return false;
    if (/^(eyJ[\w-]*\.){2}/.test(s)) return false; // JWT
    const nonLatin = (s.match(/[^\u0000-\u024F\u2000-\u206F\s.,!?;:'"()\[\]{}@#$%^&*+=<>/\\|~`_\-\u2010-\u2015\u2018\u2019\u201C\u201D\u2026]/g) || []).length;
    return nonLatin / s.length < 0.35;
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

  function walkStrings(obj, c) {
    if (obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const v of obj) walkStrings(v, c);
      return;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string') {
        if (SENSITIVE_KEY.test(k)) continue;
        if (looksEnglish(v)) c.items.push({ obj, key: k, value: v });
      } else if (v && typeof v === 'object') {
        walkStrings(v, c);
      }
    }
  }

  async function applyTranslations(items, target, autodetect) {
    // Dedupe by value.
    const unique = [];
    const seen = new Set();
    for (const it of items) {
      if (!seen.has(it.value)) { seen.add(it.value); unique.push(it.value); }
    }
    if (!unique.length) return false;

    const resp = await translateBatch(unique, target, autodetect);
    if (!resp || !Array.isArray(resp.items)) return false;

    const map = new Map();
    resp.items.forEach((it, i) => {
      if (it && it.det === 'en' && it.tx && it.tx !== unique[i]) {
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

  async function translateParams(params, c) {
    const entries = [];
    for (const [name, value] of params.entries()) {
      if (SENSITIVE_KEY.test(name)) continue;
      if (typeof value === 'string' && looksEnglish(value)) entries.push([name, value]);
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

  async function translateFormData(fd, c) {
    const entries = [];
    for (const [name, value] of fd.entries()) {
      if (typeof value !== 'string') continue;
      if (SENSITIVE_KEY.test(name)) continue;
      if (looksEnglish(value)) entries.push([name, value]);
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
      walkStrings(obj, c);
      const changed = await applyTranslations(c.items, siteLang() || '', !siteLang());
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
      if (looksEnglish(value)) out.push({ name, value });
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
})();
