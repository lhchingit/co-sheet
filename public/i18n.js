/**
 * @file i18n.js
 * @description Locale loading + translation runtime. Fetches /locales/*.json,
 * merges them into { key: { zh, en } }, and publishes t(), getLang(),
 * translatePage(), loadLocales() on window.CoSheet.i18n. Loaded as a classic
 * <script> before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};

// Full-UI translation dictionary, populated at startup from the per-language
// JSON files under /locales (en.json, zh-TW.json) by loadLocales(). Shape:
// { 'some.key': { zh: '…', en: '…' } }. Empty until the fetch resolves, at
// which point t() falls back to returning the key itself.
let I18N = {};

// Maps the internal language codes to their /locales file basenames.
const LOCALE_FILES = { zh: 'zh-TW', en: 'en' };

// Fetches every locale file and merges them into the { key: { zh, en } } shape
// that t() and translatePage() consume. Network/parse failures degrade to an
// empty dictionary rather than throwing (e.g. in non-browser test sandboxes).
const loadLocales = async () => {
  const merged = {};
  await Promise.all(Object.keys(LOCALE_FILES).map(async (lang) => {
    try {
      const res = await fetch(`/locales/${LOCALE_FILES[lang]}.json`);
      if (!res || !res.ok) return;
      const dict = await res.json();
      Object.keys(dict).forEach((key) => {
        if (!merged[key]) merged[key] = {};
        merged[key][lang] = dict[key];
      });
    } catch (err) {
      /* leave this language unloaded; t() will fall back to the key */
    }
  }));
  I18N = merged;
};

// Current UI language ('zh' default, or 'en'), from saved preference.
const getLang = () => {
  let lang = 'zh';
  try { lang = localStorage.getItem('app-language') || 'zh'; } catch (err) {}
  return lang === 'en' ? 'en' : 'zh';
};

// Translate a dictionary key for the current language, with optional {placeholders}.
const t = (key, vars) => {
  const entry = I18N[key];
  let str = (entry && entry[getLang()]) != null ? entry[getLang()] : key;
  if (vars) {
    Object.keys(vars).forEach((k) => { str = str.replace(`{${k}}`, vars[k]); });
  }
  return str;
};

// Walk the DOM and swap text / tooltips / aria-labels for the chosen language.
const translatePage = (lang) => {
  if (lang !== 'en') lang = 'zh';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const entry = I18N[el.getAttribute('data-i18n')];
    if (entry && entry[lang] != null) el.textContent = entry[lang];
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const entry = I18N[el.getAttribute('data-i18n-title')];
    if (entry && entry[lang] != null) el.setAttribute('title', entry[lang]);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const entry = I18N[el.getAttribute('data-i18n-aria')];
    if (entry && entry[lang] != null) el.setAttribute('aria-label', entry[lang]);
  });
  if (document.documentElement && typeof document.documentElement.setAttribute === 'function') {
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant');
  }
};

  root.CoSheet.i18n = { loadLocales, getLang, t, translatePage };
})();
