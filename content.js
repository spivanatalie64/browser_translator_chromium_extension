/**
 * Eilatan Lingo — content script (isolated world).
 *
 * Three jobs, one page:
 *  1. PAGE MODE   — every text node that pops up gets translated to English.
 *  2. INPUT MODE  — when you type English, it becomes the site's language.
 *  3. RELAY       — the main-world interceptor (interceptor.js) hands off
 *                   outgoing payloads here; this script translates them so
 *                   the backend sees the site's native language while the
 *                   frontend stays English.
 *
 * Site language is AUTO-DETECTED: <html lang> tag → visible text sampling →
 * per-origin memory (so revisits are instant). No picking required.
 */

(() => {
  if (window.__eilatanLingoLoaded) return;
  window.__eilatanLingoLoaded = true;

  // -------------------------------------------------------------------------
  // Utils
  // -------------------------------------------------------------------------
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'template',
    'head', 'title', 'meta', 'link', 'iframe',
    '[contenteditable="true"]', '[contenteditable=""]',
  ].join(',');

  function isSkipped(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (el.closest(SKIP_SELECTOR)) return true;
    return false;
  }

  function normalizeLangCode(raw) {
    if (!raw) return '';
    const l = String(raw).toLowerCase();
    if (l.startsWith('zh-hans') || l === 'zh' || l.startsWith('zh-cn')) return 'zh-CN';
    if (l.startsWith('zh-hant') || l.startsWith('zh-tw')) return 'zh-TW';
    if (l.startsWith('pt')) return 'pt';
    const m = l.match(/^[a-z]{2}/);
    return m ? m[0] : '';
  }

  // -------------------------------------------------------------------------
  // Settings + site language
  // -------------------------------------------------------------------------
  const DEFAULTS = { pageOn: false, inputOn: false, interactionOn: false, displayLang: 'en', siteLangOverride: '' };
  let settings = { ...DEFAULTS };

  let siteLang = normalizeLangCode(
    document.documentElement.getAttribute('lang') || ''
  );

  // The main-world interceptor reads these off <html> so it never needs its
  // own copy of settings. Sync them whenever anything changes.
  function syncMainWorld() {
    try {
      document.documentElement.dataset.etrInteraction = settings.interactionOn ? '1' : '0';
      document.documentElement.dataset.etrSiteLang = siteLang || '';
    } catch {}
  }
  syncMainWorld();

  function refreshSiteLang() {
    siteLang = normalizeLangCode(
      settings.siteLangOverride || document.documentElement.getAttribute('lang') || ''
    );
    if (siteLang) syncMainWorld();
    return siteLang;
  }

  chrome.storage.local.get('eilatanLingo', (v) => {
    Object.assign(settings, v.eilatanLingo || {});
    refreshSiteLang();
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.eilatanLingo) return;
    Object.assign(settings, changes.eilatanLingo.newValue || {});
    refreshSiteLang();
    apply();
  });

  function apply() {
    syncMainWorld();
    if (settings.pageOn) startPageTranslation();
    else stopPageTranslation();
  }

  // -------------------------------------------------------------------------
  // Page text sampling (for language detection when <html lang> is missing)
  // -------------------------------------------------------------------------
  function pageSample(maxLen) {
    const walker = document.createTreeWalker(
      document.body || document.documentElement,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || isSkipped(p) || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      }
    );
    let out = '';
    let node;
    while ((node = walker.nextNode()) && out.length < maxLen) {
      out += node.nodeValue + ' ';
    }
    return out.trim().slice(0, maxLen);
  }

  async function detectSiteLanguage() {
    if (siteLang) return siteLang;
    const sample = pageSample(800);
    if (!sample) return '';
    // resolveTarget checks per-origin memory first, then sniffs the sample.
    const r = await send({ type: 'resolveTarget', origin: location.origin, sample });
    if (r && r.detected) {
      siteLang = normalizeLangCode(r.detected);
      syncMainWorld();
    }
    return siteLang;
  }

  // -------------------------------------------------------------------------
  // PAGE MODE — site language → English
  // -------------------------------------------------------------------------
  let translatedNodes = new WeakSet(); // text nodes already showing English
  let originalText = new WeakMap();    // node -> original value (for restore)
  let translatedAttrs = new WeakMap(); // element -> [{attr, original}]
  let pageRunning = false;

  function collectTextNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const val = n.nodeValue;
        if (!val || !val.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || isSkipped(p)) return NodeFilter.FILTER_REJECT;
        if (!/[A-Za-z\u00C0-\u024F]/.test(val)) return NodeFilter.FILTER_REJECT; // needs letters
        if (translatedNodes.has(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  async function translateTextNodes(nodes) {
    const entries = nodes
      .filter((n) => !translatedNodes.has(n))
      .map((n) => ({ node: n, text: n.nodeValue }));
    if (!entries.length) return 0;

    let done = 0;
    const BATCH = 25;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const r = await send({
        type: 'translate',
        texts: batch.map((e) => e.text),
        from: siteLang || 'auto',
        to: settings.displayLang || 'en',
      });
      if (!r || !r.translations) continue;
      batch.forEach((e, idx) => {
        const t = (r.translations[idx] || '').trim();
        if (!t || t === e.text) return;
        originalText.set(e.node, e.text);
        e.node.nodeValue = t;
        translatedNodes.add(e.node);
        done++;
      });
    }
    return done;
  }

  async function translateAttributes(root) {
    const els = [...root.querySelectorAll('[title],[placeholder],[alt]')].filter(
      (el) => !isSkipped(el) && !translatedAttrs.has(el)
    );
    const want = new Map(); // value -> [attr, el][]
    const order = [];
    for (const el of els) {
      for (const attr of ['title', 'placeholder', 'alt']) {
        const val = (el.getAttribute(attr) || '').trim();
        if (!val || val.length < 3 || !/[A-Za-z\u00C0-\u024F]/.test(val)) continue;
        if (!want.has(val)) { want.set(val, []); order.push(val); }
        want.get(val).push([attr, el]);
      }
    }
    const BATCH = 25;
    for (let i = 0; i < order.length; i += BATCH) {
      const chunk = order.slice(i, i + BATCH);
      const r = await send({
        type: 'translate',
        texts: chunk,
        from: siteLang || 'auto',
        to: settings.displayLang || 'en',
      });
      if (!r || !r.translations) continue;
      chunk.forEach((val, idx) => {
        const t = (r.translations[idx] || '').trim();
        if (!t || t === val) return;
        for (const [attr, el] of want.get(val)) {
          const rec = translatedAttrs.get(el) || [];
          rec.push({ attr, original: val });
          translatedAttrs.set(el, rec);
          el.setAttribute(attr, t);
        }
      });
    }
  }

  const observer = new MutationObserver(
    debounce((mutations) => {
      if (!settings.pageOn || !pageRunning) return;
      const nodes = new Set();
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType === Node.TEXT_NODE) nodes.add(added);
          else if (added.nodeType === Node.ELEMENT_NODE) {
            for (const t of collectTextNodes(added)) nodes.add(t);
          }
        }
      }
      const fresh = [...nodes].filter(
        (n) => !translatedNodes.has(n) && n.parentElement && !isSkipped(n.parentElement)
      );
      if (fresh.length) translateTextNodes(fresh.slice(0, 300));
    }, 450)
  );

  async function startPageTranslation() {
    if (pageRunning) return;
    pageRunning = true;
    if (!siteLang) await detectSiteLanguage();
    if (siteLang && siteLang === (settings.displayLang || 'en')) {
      showToast('Site is already in English — no translation needed');
      pageRunning = false;
      return;
    }
    if (!document.body) { pageRunning = false; return; }
    const nodes = collectTextNodes(document.body).slice(0, 600);
    const count = await translateTextNodes(nodes);
    await translateAttributes(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
    if (count) showToast(`Translated ${count} bits of text → ${settings.displayLang || 'en'}`);
  }

  function stopPageTranslation() {
    pageRunning = false;
    observer.disconnect();
    for (const [node, original] of originalText) node.nodeValue = original;
    for (const [el, records] of translatedAttrs) {
      for (const { attr, original } of records) el.setAttribute(attr, original);
    }
    // Fresh stores for the next session.
    translatedNodes = new WeakSet();
    originalText = new WeakMap();
    translatedAttrs = new WeakMap();
  }

  // -------------------------------------------------------------------------
  // INPUT MODE — your English → site language
  // -------------------------------------------------------------------------
  const INPUT_SELECTOR =
    'input:not([type=hidden]):not([type=password]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]):not([type=search]), textarea, [contenteditable="true"]';

  const lastTyped = new WeakMap(); // element -> last known value (for delta logic)

  function getValue(el) {
    if (el.isContentEditable) return el.innerText;
    return el.value || '';
  }

  function setValue(el, text) {
    if (el.isContentEditable) {
      el.innerText = text;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      el.value = text;
      try { el.setSelectionRange(start, end); } catch {}
    }
    lastTyped.set(el, text);
  }

  // "Is this text English-ish?" — cheap local gate so we don't spam the API
  // with text that's obviously already in the site language.
  function looksEnglish(s) {
    if (!s || !/[A-Za-z]/.test(s)) return false;
    const nonLatin = (s.match(/[^\u0000-\u024F\u2000-\u206F\s.,!?;:'"()\[\]{}@#$%^&*+=<>/\\|~`_\-\u2010-\u2015\u2018\u2019\u201C\u201D\u2026]/g) || []).length;
    return nonLatin / Math.max(s.length, 1) < 0.35;
  }

  async function handleInputEvent(e) {
    if (!settings.inputOn) return;
    if (e.isComposing) return; // IME composition — hands off
    if (!siteLang || siteLang === 'en') return; // English site: nothing to translate to

    const el = e.target;
    if (!(el instanceof Element) || !el.matches(INPUT_SELECTOR)) return;

    const text = getValue(el);
    if (!text.trim()) { lastTyped.set(el, text); return; }

    // Delta logic: if the user just appended to what we last touched, only the
    // new bit matters for the "is this English?" gate.
    const prev = lastTyped.get(el);
    let gate = text;
    if (prev && text.startsWith(prev) && text.length > prev.length) {
      gate = text.slice(prev.length);
    }
    if (!looksEnglish(gate)) { lastTyped.set(el, text); return; }

    const r = await send({ type: 'translate', texts: [text], from: 'auto', to: siteLang, detect: true });
    if (!r || !r.translations) return;
    const detected = r.detected || '';
    if (detected && detected !== 'en') { lastTyped.set(el, text); return; } // already site language
    const t = (r.translations[0] || '').trim();
    if (!t || t === text) { lastTyped.set(el, text); return; }

    setValue(el, t);
    showToast(`→ ${t.length > 60 ? t.slice(0, 60) + '…' : t}`);
  }

  // Ctrl+Enter forces translation of the focused field, no matter what's in it.
  async function forceTranslateField(el) {
    if (!settings.inputOn || !siteLang || siteLang === 'en') return;
    const text = getValue(el);
    if (!text.trim()) return;
    const r = await send({ type: 'translate', texts: [text], from: 'auto', to: siteLang });
    if (r && r.translations && r.translations[0]) setValue(el, r.translations[0]);
  }

  document.addEventListener('input', debounce(handleInputEvent, 650), true);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const el = document.activeElement;
      if (el && el.matches(INPUT_SELECTOR)) {
        e.preventDefault();
        forceTranslateField(el);
      }
    }
  }, true);

  // -------------------------------------------------------------------------
  // Toast
  // -------------------------------------------------------------------------
  let toastEl = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'max-width:320px', 'padding:10px 14px', 'border-radius:10px',
        'background:rgba(30,27,46,0.95)', 'color:#e8e6f0',
        'font:12px/1.4 system-ui,sans-serif', 'box-shadow:0 6px 24px rgba(0,0,0,.35)',
        'pointer-events:none', 'opacity:0', 'transition:opacity .2s',
      ].join(';');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => (toastEl.style.opacity = '0'), 2200);
  }

  // -------------------------------------------------------------------------
  // Popup / message protocol
  // -------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'getState') {
      sendResponse({
        siteLang,
        pageOn: settings.pageOn,
        inputOn: settings.inputOn,
        interactionOn: settings.interactionOn,
        displayLang: settings.displayLang,
      });
    }
  });

  // -------------------------------------------------------------------------
  // Main-world relay (interceptor.js lives in the page's world and cannot use
  // chrome.runtime, so it shouts into the DOM and we pipe it to the worker.)
  // -------------------------------------------------------------------------
  async function resolveTargetForRelay() {
    if (siteLang) return siteLang;
    return detectSiteLanguage();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'etr-lingo-main') return;

    if (d.type === 'translate-batch') {
      (async () => {
        const texts = Array.isArray(d.texts) ? d.texts.slice(0, 40) : [];
        let target = typeof d.target === 'string' ? d.target : '';
        if (!target && d.autodetect) target = await resolveTargetForRelay();
        if (!texts.length || !target || target === 'en') {
          window.postMessage({ source: 'etr-lingo-isolated', id: d.id, items: null, target }, '*');
          return;
        }
        const r = await send({ type: 'translate', texts, from: 'auto', to: target, detect: true });
        if (!r || !r.translations) {
          window.postMessage({ source: 'etr-lingo-isolated', id: d.id, items: null, target }, '*');
          return;
        }
        const items = texts.map((t, i) => ({
          original: t,
          tx: r.translations[i] != null ? r.translations[i] : '',
          det: r.detections && r.detections[i] ? r.detections[i] : '',
        }));
        window.postMessage({ source: 'etr-lingo-isolated', id: d.id, items, target }, '*');
      })().catch(() => {
        window.postMessage({ source: 'etr-lingo-isolated', id: d.id, items: null, target: d.target }, '*');
      });
      return;
    }

    if (d.type === 'resolve-target') {
      resolveTargetForRelay()
        .then((t) => {
          window.postMessage({ source: 'etr-lingo-isolated', id: d.id, target: t || '' }, '*');
        })
        .catch(() => {
          window.postMessage({ source: 'etr-lingo-isolated', id: d.id, target: '' }, '*');
        });
    }
  });

  // Auto-kick detection early: if the site has no <html lang> tag, sniff it
  // right after load so the first interaction never has to wait.
  if (!siteLang) {
    const kick = () => { if (!siteLang) detectSiteLanguage(); };
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(kick, 800);
    } else {
      document.addEventListener('DOMContentLoaded', kick, { once: true });
    }
  }

  apply();
})();
