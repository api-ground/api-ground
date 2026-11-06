import en from './locales/en.js';
import ja from './locales/ja.js';

// Korean is the source language: UI strings are written in Korean and looked up in the other dictionaries.
const DICTS = { en, ja };
export const LANGUAGES = [
  { id: 'system', label: null },
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
];
const LOCALES = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' };

function readSetting() {
  try { return localStorage.getItem('pg_lang') || 'system'; } catch { return 'system'; }
}

function resolve(setting) {
  if (setting && setting !== 'system' && LOCALES[setting]) return setting;
  const nav = (navigator.languages?.[0] || navigator.language || 'en').slice(0, 2).toLowerCase();
  return LOCALES[nav] ? nav : 'en';
}

let setting = readSetting();
let current = resolve(setting);
document.documentElement.lang = current;

export const langSetting = () => setting;
export const lang = () => current;
export const locale = () => LOCALES[current];

export function setLanguage(id) {
  try { localStorage.setItem('pg_lang', id); } catch {}
  location.reload();
}

export function t(s, vars) {
  let out = current === 'ko' ? s : DICTS[current]?.[s] ?? s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return out;
}
