// The database keeps its original name so chats saved before the rename to API-Ground are not lost.
const DB_NAME = 'ai-playground';
const STORE = 'kv';

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function idbGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const DEFAULT_SETTINGS = {
  name: '',
  preferences: '',
  theme: 'system',
  font: 'serif',
  keys: {},
  password: '',
  provider: 'gemini',
  model: {},
  style: 'normal',
  customStyles: [],
  tools: { search: false, thinking: false, urlContext: false, codeExecution: false },
  artifacts: true,
  autoTitle: true,
  params: { temperature: null, topP: null, maxTokens: null },
  systemPrompt: '',
  sidebarCollapsed: false,
  codeMode: 'ask',
  memoryEnabled: true,
  memories: [],
  serverUrl: '',
  bases: {},
  autoSwitch: false,
  budgets: {},
};

export const app = {
  settings: structuredClone(DEFAULT_SETTINGS),
  chats: [],
  projects: [],
  code: [],
  usage: {},
  config: { providers: [], passwordRequired: false },
  models: {},
  busy: null,
};

const timers = {};
let persistHook = null;
export function onPersist(fn) { persistHook = fn; }
export function persist(key) {
  persistHook?.(key);
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    idbSet(key, app[key]).catch((e) => console.error('save failed', key, e));
  }, 250);
}

export async function initState() {
  try {
    const [settings, chats, projects, code, usage] = await Promise.all(['settings', 'chats', 'projects', 'code', 'usage'].map(idbGet));
    if (settings) app.settings = { ...structuredClone(DEFAULT_SETTINGS), ...settings, tools: { ...DEFAULT_SETTINGS.tools, ...(settings.tools || {}) }, params: { ...DEFAULT_SETTINGS.params, ...(settings.params || {}) } };
    app.chats = chats || [];
    app.projects = projects || [];
    app.code = code || [];
    app.usage = usage || {};
  } catch (e) {
    console.error('IndexedDB unavailable', e);
  }
  // carry over keys saved by the earlier single-page version
  try {
    const oldKeys = JSON.parse(localStorage.getItem('pg_keys') || 'null');
    const oldPw = JSON.parse(localStorage.getItem('pg_password') || 'null');
    if (oldKeys && !Object.keys(app.settings.keys).length) app.settings.keys = oldKeys;
    if (oldPw && !app.settings.password) app.settings.password = oldPw;
    if (oldKeys || oldPw) {
      ['keys', 'password', 'chats', 'provider', 'selectedModel', 'systemPrompt', 'params', 'tools'].forEach((k) => localStorage.removeItem('pg_' + k));
      persist('settings');
    }
  } catch {}
}

const listeners = new Set();
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(evt, data) { listeners.forEach((fn) => fn(evt, data)); }
