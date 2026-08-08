/**
 * Eilatan Lingo — popup controller.
 * Reads/writes chrome.storage.local and pokes the active tab for state.
 */

'use strict';

const LANG_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian',
  tr: 'Turkish', ar: 'Arabic', he: 'Hebrew', fa: 'Persian', hi: 'Hindi',
  ur: 'Urdu', bn: 'Bengali', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian',
  ms: 'Malay', ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)', sv: 'Swedish', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
  el: 'Greek', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian',
  lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ca: 'Catalan', eu: 'Basque',
  gl: 'Galician', sq: 'Albanian', mk: 'Macedonian', is: 'Icelandic', ga: 'Irish',
  sw: 'Swahili', af: 'Afrikaans', tl: 'Filipino', km: 'Khmer', lo: 'Lao',
  my: 'Burmese', ne: 'Nepali', si: 'Sinhala', ta: 'Tamil', te: 'Telugu',
  kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', gu: 'Gujarati', pa: 'Punjabi',
  az: 'Azerbaijani', uz: 'Uzbek', kk: 'Kazakh', ky: 'Kyrgyz', tg: 'Tajik',
  hy: 'Armenian', ka: 'Georgian', mn: 'Mongolian', am: 'Amharic', mg: 'Malagasy',
  zu: 'Zulu', xh: 'Xhosa', so: 'Somali', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo',
};

const els = {
  siteLang: document.getElementById('siteLang'),
  siteLangLabel: document.getElementById('siteLangLabel'),
  displayLangLabel: document.getElementById('displayLangLabel'),
  pageOn: document.getElementById('pageOn'),
  inputOn: document.getElementById('inputOn'),
  displayLang: document.getElementById('displayLang'),
  siteLangOverride: document.getElementById('siteLangOverride'),
  interactionOn: document.getElementById('interactionOn'),
  siteLangLabel2: document.getElementById('siteLangLabel2'),
};

let settings = {};
let tabId = null;

// ---- populate selects -----------------------------------------------------
function fillSelect(sel, names, selected) {
  sel.innerHTML = '';
  for (const [code, name] of Object.entries(names)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${name} (${code})`;
    opt.selected = code === selected;
    sel.appendChild(opt);
  }
}

// ---- render ---------------------------------------------------------------
function render() {
  els.pageOn.checked = !!settings.pageOn;
  els.inputOn.checked = !!settings.inputOn;
  els.interactionOn.checked = !!settings.interactionOn;
  els.displayLang.value = settings.displayLang || 'en';
  els.siteLangOverride.value = settings.siteLangOverride || '';
  els.displayLangLabel.textContent = LANG_NAMES[settings.displayLang] || settings.displayLang || 'English';
}

function renderSiteLang(code) {
  const name = code ? LANG_NAMES[code] || code : 'site language (unknown)';
  if (!code) {
    els.siteLang.textContent = '?';
    els.siteLang.title = 'Site language unknown — autodetecting…';
  } else {
    els.siteLang.textContent = name;
    els.siteLang.title = `Detected site language: ${code}`;
  }
  els.siteLangLabel.textContent = name;
  els.siteLangLabel2.textContent = name;
}

// ---- save ---------------------------------------------------------------
function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.local.set({ eilatanLingo: settings });
  if (tabId !== null) {
    chrome.tabs.sendMessage(tabId, { type: 'settingsChanged', settings }).catch(() => {});
  }
  render();
}

els.pageOn.addEventListener('change', () => save({ pageOn: els.pageOn.checked }));
els.inputOn.addEventListener('change', () => save({ inputOn: els.inputOn.checked }));
els.interactionOn.addEventListener('change', () => save({ interactionOn: els.interactionOn.checked }));
els.displayLang.addEventListener('change', () => save({ displayLang: els.displayLang.value }));
els.siteLangOverride.addEventListener('change', () => save({ siteLangOverride: els.siteLangOverride.value }));

// ---- boot ---------------------------------------------------------------
(async function boot() {
  fillSelect(els.displayLang, LANG_NAMES, 'en');
  fillSelect(els.siteLangOverride, LANG_NAMES, '');
  els.siteLangOverride.insertBefore(
    new Option('Auto (from page / detected)', ''),
    els.siteLangOverride.firstChild
  );

  const { eilatanLingo } = await chrome.storage.local.get('eilatanLingo');
  settings = { pageOn: false, inputOn: false, interactionOn: false, displayLang: 'en', siteLangOverride: '', ...(eilatanLingo || {}) };
  render();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id !== undefined ? tab.id : null;
  if (tabId === null) return;

  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: 'getState' });
    renderSiteLang(state.siteLang || '');
  } catch {
    // Content script not present (chrome:// pages, web store, etc.)
    els.siteLang.textContent = 'n/a';
    els.siteLang.title = 'This page cannot be translated';
    els.siteLangLabel.textContent = 'n/a';
  }
})();
