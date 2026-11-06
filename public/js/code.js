import { app, persist, emit } from './state.js';
import { h, icon, iconBtn, toast, uid, popover, menuItem, confirmDialog, promptDialog, downloadBlob, timeAgo, isTextFile, esc } from './ui.js';
import { postJSON, currentModel, modelLabel, providerInfo, isGemini, hasKey } from './api.js';
import { recordUsage, recordLimits, recordLimitError, fallbackCandidates, switchTo, switchActions, usageButton } from './usage.js';
import { renderMarkdown } from './markdown.js';
import { sandboxFrame, closeArtifact } from './artifacts.js';
import { openModelPicker } from './chat.js';
import { openSettings } from './settings.js';
import { t as tr, lang } from './i18n.js';

const desktop = window.desktop || null;
export const isDesktop = Boolean(desktop);

// ---------- tools ----------
const P = (props, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const BASE_TOOLS = [
  { name: 'list_files', description: 'List files in the project (recursively, skipping node_modules/.git etc.) with sizes. Optionally limit to a directory.', parameters: P({ dir: { type: 'string', description: 'Optional directory, e.g. "src"' } }) },
  { name: 'read_file', description: 'Read a text file. Returns content with line numbers. Use offset/limit for large files.', parameters: P({ path: { type: 'string' }, offset: { type: 'integer', description: '1-based start line' }, limit: { type: 'integer', description: 'Max lines to return' } }, ['path']) },
  { name: 'write_file', description: 'Create a new file (parent folders are created) or completely overwrite an existing file.', parameters: P({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
  { name: 'edit_file', description: 'Replace an exact string in a file. old_string must match exactly (including whitespace and indentation) and be unique unless replace_all is true. Read the file first.', parameters: P({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
  { name: 'delete_file', description: 'Delete a single file.', parameters: P({ path: { type: 'string' } }, ['path']) },
  { name: 'grep', description: 'Search file contents with a JavaScript regular expression (case-insensitive). Returns matching lines as path:line: text.', parameters: P({ pattern: { type: 'string' }, path: { type: 'string', description: 'Optional directory to limit the search' } }, ['pattern']) },
  { name: 'run_javascript', description: 'Execute JavaScript in an isolated browser sandbox (no file or network access to the project, async/await allowed) and return console output and the returned value.', parameters: P({ code: { type: 'string' } }, ['code']) },
  { name: 'todo_write', description: 'Create or update the task list for the current work. Send the full list every time. Keep exactly one item in_progress while working.', parameters: P({ todos: { type: 'array', items: P({ content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, ['content', 'status']) } }, ['todos']) },
];
const LOCAL_TOOLS = [
  { name: 'run_command', description: 'Run a shell command in the project folder and wait for it to finish. Returns the exit code and combined stdout/stderr. Use it to install packages, build, run tests, scripts, git, etc. Commands must be non-interactive. For long-running servers or watchers set background=true.', parameters: P({ command: { type: 'string' }, timeout_sec: { type: 'integer', description: 'Max seconds to wait (default 120, max 600)' }, background: { type: 'boolean', description: 'Start in the background and return a process id immediately' } }, ['command']) },
  { name: 'process_output', description: 'Get new output and status of a background process started with run_command(background=true).', parameters: P({ id: { type: 'string' } }, ['id']) },
  { name: 'kill_process', description: 'Stop a background process.', parameters: P({ id: { type: 'string' } }, ['id']) },
];
const READ_ONLY = new Set(['list_files', 'read_file', 'grep', 'todo_write', 'process_output']);

function toolsFor(session, mode) {
  let t = session.kind === 'local' ? [...BASE_TOOLS, ...LOCAL_TOOLS] : BASE_TOOLS;
  if (mode === 'plan') t = t.filter((x) => READ_ONLY.has(x.name));
  return t;
}

const MODES = [
  { id: 'ask', label: tr('편집 전 확인'), desc: tr('파일 변경과 명령 실행 전에 허락을 구합니다') },
  { id: 'auto', label: tr('편집 자동 수락'), desc: tr('변경 사항과 명령을 바로 실행합니다') },
  { id: 'plan', label: tr('계획 모드'), desc: tr('파일을 읽기만 하고 실행 계획을 제안합니다') },
];

const WORK_RULES = `How to work:
- For tasks with several steps, call todo_write first with a short plan, keep exactly one item in_progress, and mark items completed as you finish them.
- Read a file before editing it. Prefer edit_file with a unique old_string for targeted changes; use write_file for new files or full rewrites.
- Stay focused on what the user asked; do not create unnecessary files.
- Be concise. Before a tool call write at most one short sentence. When done, briefly summarize what changed (no full code dumps unless asked).
- Reply in the user's language.`;

function systemPrompt(session, mode, memory) {
  let s;
  if (session.kind === 'local') {
    const win = (desktop?.platform || 'win32') === 'win32';
    s = `You are an expert software engineering agent running as a desktop coding assistant, similar to a terminal coding agent. You have access to a real project folder on the user's computer.

Environment:
- Project folder: ${session.root}. All file paths are relative to it.
- OS: ${win ? 'Windows' : desktop?.platform}. run_command uses ${win ? 'PowerShell (use PowerShell syntax; chain commands with ";", not "&&")' : 'bash'} with the project folder as the working directory.
- You can read, create, edit and delete files, search with grep, and run shell commands (npm, node, python, git, test runners, builds — whatever is installed on the machine).
- Commands must be non-interactive: pass flags such as --yes / -y and never start programs that wait for keyboard input.
- For dev servers or watchers use run_command with background=true, then check process_output. Tell the user the local URL (e.g. http://localhost:5173); they can open it in the Preview tab.
- Verify your work when possible: run the build, tests or the program and fix errors you introduce.
- Never run destructive commands outside the project (deleting system files, formatting drives, git push --force, etc.) unless the user explicitly asks.

${WORK_RULES}`;
    if (memory) s += '\n\n# Project memory (AGENTS.md)\n' + memory.slice(0, 20000);
  } else {
    const files = Object.keys(session.files).sort();
    s = `You are an expert software engineering agent working inside a browser-based coding workspace, similar to a terminal coding agent.

Environment:
- The workspace is a virtual in-browser file system containing text files only. Paths are relative, like "index.html" or "src/app.js". There is no shell, package manager or network access from tools.
- The user sees a live preview of index.html. Local stylesheets (<link rel="stylesheet" href="style.css">) and classic scripts (<script src="app.js">) are inlined automatically. ES module imports between local files are NOT supported. Scripts from CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com) do work in the preview.
- run_javascript runs plain JavaScript in an isolated sandbox and returns console output. Use it to check logic when useful.

${WORK_RULES}

Current files (${files.length}): ${files.length ? files.join(', ') : '(empty workspace)'}`;
  }
  if (mode === 'plan') s += '\n\nPLAN MODE IS ACTIVE: you may only use read-only tools. Investigate as needed, then answer with a concise, concrete, numbered implementation plan. Do not try to modify files or run commands.';
  return s;
}

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/+$/, '').trim();

function checkPath(p) {
  const path = normPath(p);
  if (!path || path.split('/').some((s) => s === '..' || s === '') || /^[a-zA-Z]:/.test(path)) throw new Error('Invalid path: ' + p + ' (use a path relative to the project)');
  return path;
}

const lines = (s) => (s === '' ? 0 : s.split('\n').length);
const kb = (n) => (n < 1024 ? n + ' B' : Math.round(n / 1024) + ' KB');

// File-system adapter: real folder (desktop) or in-browser files.
function fsFor(session) {
  if (session.kind === 'local') {
    const r = session.root;
    return {
      local: true,
      list: (dir) => desktop.list(r, dir),
      read: (p) => desktop.read(r, p),
      write: (p, c) => desktop.write(r, p, c),
      remove: (p) => desktop.remove(r, p),
      exists: (p) => desktop.exists(r, p),
      grep: (pattern, prefix) => desktop.grep(r, pattern, prefix),
    };
  }
  const F = session.files;
  return {
    local: false,
    list: async (dir) => ({ files: Object.keys(F).filter((p) => !dir || p.startsWith(normPath(dir) + '/') || p === normPath(dir)).sort().map((p) => ({ path: p, size: F[p].length })), truncated: false }),
    read: async (p) => { if (F[p] == null) throw new Error('File not found: ' + p); return F[p]; },
    write: async (p, c) => { F[p] = c; },
    remove: async (p) => { if (F[p] == null) throw new Error('File not found: ' + p); delete F[p]; },
    exists: async (p) => F[p] != null,
    grep: async (pattern, prefix) => {
      let re;
      try { re = new RegExp(pattern, 'i'); } catch { throw new Error('Invalid regex: ' + pattern); }
      const pre = normPath(prefix);
      const hits = [];
      for (const p of Object.keys(F).sort()) {
        if (pre && !p.startsWith(pre)) continue;
        F[p].split('\n').forEach((l, i) => { if (hits.length < 200 && re.test(l)) hits.push(p + ':' + (i + 1) + ': ' + l.slice(0, 300)); });
      }
      return hits;
    },
  };
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const out = [];
  const ctx = 2;
  for (let i = Math.max(0, s - ctx); i < s; i++) out.push({ t: ' ', n: i + 1, s: A[i] });
  const removed = A.slice(s, A.length - e), added = B.slice(s, B.length - e);
  removed.slice(0, 60).forEach((l, i) => out.push({ t: '-', n: s + i + 1, s: l }));
  if (removed.length > 60) out.push({ t: '…', s: tr('… {n}줄 더', { n: removed.length - 60 }) });
  added.slice(0, 60).forEach((l, i) => out.push({ t: '+', n: s + i + 1, s: l }));
  if (added.length > 60) out.push({ t: '…', s: tr('… {n}줄 더', { n: added.length - 60 }) });
  for (let i = B.length - e; i < Math.min(B.length, B.length - e + ctx); i++) out.push({ t: ' ', n: i + 1, s: B[i] });
  return { diff: out, removed: removed.length, added: added.length };
}

function runSandboxed(code, timeout = 10000) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    const token = uid();
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMsg);
      iframe.remove();
      resolve(out);
    };
    const onMsg = (e) => {
      if (e.source !== iframe.contentWindow || !e.data || e.data.token !== token) return;
      if (e.data.ready) iframe.contentWindow.postMessage({ code }, '*');
      else finish((e.data.out || []).join('\n') || tr('(출력 없음)'));
    };
    window.addEventListener('message', onMsg);
    iframe.srcdoc = '<script>(function(){var T=' + JSON.stringify(token) + ';var out=[];'
      + 'function fmt(a){return a.map(function(x){if(typeof x==="string")return x;try{return JSON.stringify(x)}catch(e){return String(x)}}).join(" ")}'
      + '["log","info","warn","error","debug"].forEach(function(k){console[k]=function(){out.push((k==="log"||k==="info"?"":k+": ")+fmt([].slice.call(arguments)))}});'
      + 'addEventListener("message",async function(e){try{var F=Object.getPrototypeOf(async function(){}).constructor;var r=await new F(e.data.code)();if(r!==undefined)out.push("=> "+fmt([r]))}catch(err){out.push("Error: "+(err&&err.stack||err))}parent.postMessage({token:T,out:out.slice(0,500)},"*")});'
      + 'parent.postMessage({token:T,ready:true},"*")})()<\/script>';
    document.body.appendChild(iframe);
    setTimeout(() => finish('Error: execution timed out after ' + timeout / 1000 + ' seconds and was stopped.'), timeout);
  });
}

// ---------- state ----------
let run = null; // { sessionId, ctrl, stop }
const approvals = new Map();
let view = null;

function getSession(id) { return app.code.find((s) => s.id === id); }

function save(session) {
  session.updatedAt = Date.now();
  persist('code');
}

function newSession(title = tr('새 세션'), extra = {}) {
  const s = { id: uid(), title, kind: 'browser', root: null, createdAt: Date.now(), updatedAt: Date.now(), files: {}, history: [], historyProvider: null, log: [], todos: [], usage: { input: 0, output: 0 }, ...extra };
  app.code.unshift(s);
  persist('code');
  emit('code');
  return s;
}

const STARTER = {
  'index.html': '<!doctype html>\n<html lang="' + lang() + '">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>' + tr('새 프로젝트') + '</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>' + tr('안녕하세요!') + '</h1>\n    <p>' + tr('Code 모드에서 이 프로젝트를 만들어 보세요.') + '</p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n',
  'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n  display: grid;\n  place-items: center;\n  min-height: 100vh;\n}\n',
  'app.js': "console.log('ready');\n",
};

// ---------- tool execution ----------
async function approve(entry) {
  if (app.settings.codeMode === 'auto') return 'allow';
  entry.status = 'awaiting';
  renderLog();
  const decision = await new Promise((resolve) => approvals.set(entry.id, resolve));
  approvals.delete(entry.id);
  if (decision === 'always') { app.settings.codeMode = 'auto'; persist('settings'); renderModeBtn(); }
  return decision;
}

async function execTool(session, call, entry) {
  const a = call.args || {};
  const fs = fsFor(session);
  try {
    switch (call.name) {
      case 'list_files': {
        const { files, truncated } = await fs.list(a.dir ? checkPath(a.dir) : '');
        entry.summary = tr('{n}개 파일', { n: files.length }) + (truncated ? tr(' (일부만)') : '');
        return files.length ? files.map((f) => f.path + ' (' + kb(f.size) + ')').join('\n') + (truncated ? '\n... (list truncated)' : '') : '(no files)';
      }
      case 'read_file': {
        const p = checkPath(a.path);
        const all = (await fs.read(p)).split('\n');
        const start = Math.max(1, a.offset || 1);
        const lim = Math.min(a.limit || 2000, 4000);
        const slice = all.slice(start - 1, start - 1 + lim);
        entry.summary = tr('{n}줄 읽음', { n: slice.length }) + (all.length > slice.length ? tr(' (전체 {n}줄)', { n: all.length }) : '');
        return slice.map((l, i) => String(start + i).padStart(5) + '\t' + l).join('\n') + (start - 1 + lim < all.length ? '\n... (' + (all.length - (start - 1 + lim)) + ' more lines)' : '');
      }
      case 'grep': {
        const hits = await fs.grep(String(a.pattern || ''), a.path ? checkPath(a.path) : '');
        entry.summary = tr('{n}개 일치', { n: hits.length });
        return hits.join('\n') || 'No matches.';
      }
      case 'todo_write': {
        session.todos = (Array.isArray(a.todos) ? a.todos : []).map((t) => ({ content: String(t.content || ''), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
        entry.todos = session.todos.map((t) => ({ ...t }));
        renderTodos();
        return 'Todo list updated.';
      }
      case 'write_file': {
        const p = checkPath(a.path);
        const content = String(a.content ?? '');
        let old = null;
        if (await fs.exists(p)) { try { old = await fs.read(p); } catch { old = ''; } }
        if (old != null) { const d = lineDiff(old, content); entry.diff = d.diff; entry.summary = tr('+{a} -{r}줄', { a: d.added, r: d.removed }); }
        else {
          entry.diff = content.split('\n').slice(0, 40).map((s, i) => ({ t: '+', n: i + 1, s }));
          if (lines(content) > 40) entry.diff.push({ t: '…', s: tr('… {n}줄 더', { n: lines(content) - 40 }) });
          entry.summary = tr('새 파일 · {n}줄', { n: lines(content) });
        }
        if ((await approve(entry)) === 'deny') return deny(entry);
        await fs.write(p, content);
        afterFileChange(p);
        return (old != null ? 'Overwrote ' : 'Created ') + p + ' (' + lines(content) + ' lines).';
      }
      case 'edit_file': {
        const p = checkPath(a.path);
        const cur = await fs.read(p);
        const oldS = String(a.old_string ?? ''), newS = String(a.new_string ?? '');
        if (!oldS) throw new Error('old_string is empty.');
        const count = cur.split(oldS).length - 1;
        if (!count) throw new Error('old_string not found in ' + p + '. Read the file and copy the exact text, including whitespace.');
        if (count > 1 && !a.replace_all) throw new Error('old_string occurs ' + count + ' times in ' + p + '. Add more surrounding context to make it unique, or set replace_all.');
        const next = a.replace_all ? cur.split(oldS).join(newS) : cur.replace(oldS, () => newS);
        const d = lineDiff(cur, next);
        entry.diff = d.diff;
        entry.summary = tr('+{a} -{r}줄', { a: d.added, r: d.removed });
        if ((await approve(entry)) === 'deny') return deny(entry);
        await fs.write(p, next);
        afterFileChange(p);
        return 'Edited ' + p + (count > 1 ? ' (' + count + ' replacements)' : '') + '.';
      }
      case 'delete_file': {
        const p = checkPath(a.path);
        if (!(await fs.exists(p))) throw new Error('File not found: ' + p);
        entry.summary = tr('{p} 삭제', { p });
        if ((await approve(entry)) === 'deny') return deny(entry);
        await fs.remove(p);
        afterFileChange(p);
        return 'Deleted ' + p + '.';
      }
      case 'run_javascript': {
        if ((await approve(entry)) === 'deny') return deny(entry);
        entry.status = 'running';
        renderLog();
        const out = await runSandboxed(String(a.code || ''));
        entry.output = out;
        entry.summary = out.startsWith('Error') ? tr('오류') : tr('실행 완료');
        return out;
      }
      case 'run_command': {
        if (session.kind !== 'local') throw new Error('run_command is only available for local folders.');
        const cmd = String(a.command || '').trim();
        if (!cmd) throw new Error('command is empty.');
        if ((await approve(entry)) === 'deny') return deny(entry);
        entry.status = 'running';
        renderLog();
        if (a.background) {
          const r = await desktop.start(session.root, cmd);
          entry.procId = r.id;
          entry.output = r.output;
          entry.summary = r.running ? tr('백그라운드 실행 중 · id {id}', { id: r.id }) : tr('종료됨 · exit {code}', { code: r.exitCode });
          return (r.running ? 'Started background process id=' + r.id + '.' : 'Process exited immediately with code ' + r.exitCode + '.') + '\nOutput so far:\n' + (r.output || '(none)');
        }
        const r = await desktop.run(session.root, cmd, a.timeout_sec);
        entry.output = r.output;
        entry.summary = r.killed ? tr('사용자가 중단함') : r.timedOut ? tr('시간 초과로 중단됨') : 'exit ' + r.exitCode;
        if (r.exitCode !== 0 && !r.timedOut) entry.status = 'error';
        afterFileChange(null);
        return 'Exit code: ' + r.exitCode + (r.timedOut ? ' (timed out and killed)' : '') + (r.killed ? ' (killed by user)' : '') + '\n' + (r.output || '(no output)');
      }
      case 'process_output': {
        const r = await desktop.output(String(a.id));
        entry.output = r.output;
        entry.summary = r.running ? tr('실행 중') : tr('종료됨 · exit {code}', { code: r.exitCode });
        return 'Status: ' + (r.running ? 'running' : 'exited with code ' + r.exitCode) + '\nNew output:\n' + (r.output || '(none)');
      }
      case 'kill_process': {
        if ((await approve(entry)) === 'deny') return deny(entry);
        await desktop.kill(String(a.id));
        entry.summary = tr('중지함');
        return 'Process ' + a.id + ' stopped.';
      }
      default:
        throw new Error('Unknown tool: ' + call.name);
    }
  } catch (e) {
    entry.status = 'error';
    entry.summary = e.message;
    return 'Error: ' + e.message;
  }
}

function deny(entry) {
  entry.status = 'denied';
  entry.summary = tr('사용자가 거부함') + (entry.feedback ? ': ' + entry.feedback : '');
  return 'The user denied this action.' + (entry.feedback ? ' User feedback: ' + entry.feedback : ' Ask the user how they would like to proceed.');
}

function afterFileChange(path) {
  if (!view) return;
  if (path) view.flash = path;
  renderFiles();
  schedulePreview();
}

// ---------- provider-native history ----------
function nativeUser(provider, text) {
  return isGemini(provider) ? { role: 'user', parts: [{ text }] } : { role: 'user', content: text };
}

function nativeResults(provider, results) {
  if (providerInfo(provider).type === 'anthropic') {
    // All tool results for one assistant turn go back in a single user message.
    return [{ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.output, ...(r.output.startsWith('Error:') ? { is_error: true } : {}) })) }];
  }
  if (isGemini(provider)) {
    return [{ role: 'user', parts: results.map((r) => ({ functionResponse: { name: r.name, ...(r.callId && !/^call_\d+$/.test(r.callId) ? { id: r.callId } : {}), response: { output: r.output } } })) }];
  }
  return results.map((r) => ({ role: 'tool', tool_call_id: r.callId, content: r.output }));
}

// ---------- handing a session to another provider ----------
// Each provider keeps tool calls in its own message format. To switch mid-task, the history is converted to a
// neutral transcript ({role:'user',text} | {role:'assistant',text,thoughts,calls} | {role:'tool',results})
// and rebuilt for the new provider, so the new model sees every earlier step and tool result.
const typeOf = (provider) => (providerInfo(provider).type === 'anthropic' ? 'anthropic' : isGemini(provider) ? 'gemini' : 'openai');
const asText = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('') : v == null ? '' : JSON.stringify(v));

function toNeutral(type, history) {
  const out = [];
  let n = 0;
  const newId = () => 'call' + String(++n).padStart(5, '0'); // 9 alphanumerics: valid for every provider (Mistral needs exactly 9)
  let ids = new Map();   // old call id -> new id, for the latest assistant turn
  let pending = [];      // calls of the latest assistant turn, for providers that return results in order without ids
  const addTool = (r) => {
    const last = out.at(-1);
    if (last?.role === 'tool') last.results.push(r); else out.push({ role: 'tool', results: [r] });
  };
  const addUser = (text) => { if (text.trim()) out.push({ role: 'user', text }); };
  const startAssistant = () => { ids = new Map(); pending = []; const t = { role: 'assistant', text: '', thoughts: '', calls: [] }; out.push(t); return t; };
  const addCall = (turn, id, name, args) => {
    const nid = newId();
    if (id) ids.set(id, nid);
    pending.push({ id: nid, name });
    turn.calls.push({ id: nid, name, args: args || {} });
  };
  const matchResult = (id, name) => {
    const nid = (id && ids.get(id)) || pending.find((c) => c.name === name && !c.used)?.id || pending.find((c) => !c.used)?.id;
    const c = pending.find((x) => x.id === nid);
    if (c) c.used = true;
    return c ? { id: c.id, name: c.name } : null;
  };

  for (const m of history) {
    if (type === 'anthropic') {
      if (m.role === 'assistant') {
        const t = startAssistant();
        for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: asText(m.content) }]) {
          if (b.type === 'text') t.text += b.text;
          else if (b.type === 'thinking') t.thoughts += b.thinking || '';
          else if (b.type === 'tool_use') addCall(t, b.id, b.name, b.input);
        }
      } else if (typeof m.content === 'string') addUser(m.content);
      else {
        for (const b of m.content || []) {
          if (b.type === 'tool_result') { const c = matchResult(b.tool_use_id); if (c) addTool({ ...c, output: asText(b.content) }); }
          else if (b.type === 'text') addUser(b.text);
        }
      }
    } else if (type === 'gemini') {
      if (m.role === 'model') {
        const t = startAssistant();
        for (const p of m.parts || []) {
          if (p.functionCall) addCall(t, p.functionCall.id, p.functionCall.name, p.functionCall.args);
          else if (p.text) { if (p.thought) t.thoughts += p.text; else t.text += p.text; }
        }
      } else {
        for (const p of m.parts || []) {
          if (p.functionResponse) {
            const c = matchResult(p.functionResponse.id, p.functionResponse.name);
            const r = p.functionResponse.response;
            if (c) addTool({ ...c, output: typeof r?.output === 'string' ? r.output : JSON.stringify(r ?? '') });
          } else if (p.text) addUser(p.text);
        }
      }
    } else {
      if (m.role === 'assistant') {
        const t = startAssistant();
        t.text = asText(m.content);
        t.thoughts = m.reasoning_content || '';
        for (const tc of m.tool_calls || []) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          addCall(t, tc.id, tc.function?.name, args);
        }
      } else if (m.role === 'tool') {
        const c = matchResult(m.tool_call_id);
        if (c) addTool({ ...c, output: asText(m.content) });
      } else if (m.role === 'user') addUser(asText(m.content));
    }
  }
  // Every call needs a result right after it; drop calls that never got one (e.g. the run was interrupted).
  for (let i = 0; i < out.length; i++) {
    const t = out[i];
    if (t.role !== 'assistant' || !t.calls.length) continue;
    const answered = new Set(out[i + 1]?.role === 'tool' ? out[i + 1].results.map((r) => r.id) : []);
    t.calls = t.calls.filter((c) => answered.has(c.id));
  }
  return out.filter((t) => t.role !== 'assistant' || t.text.trim() || t.calls.length);
}

function fromNeutral(provider, turns) {
  const type = typeOf(provider);
  const keepReasoning = providerInfo(provider).keepReasoning;
  const out = [];
  for (const t of turns) {
    if (t.role === 'user') out.push(nativeUser(provider, t.text));
    else if (t.role === 'tool') out.push(...nativeResults(provider, t.results.map((r) => ({ callId: r.id, name: r.name, output: r.output }))));
    else if (type === 'anthropic') {
      const content = [];
      if (t.text.trim()) content.push({ type: 'text', text: t.text });
      for (const c of t.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content });
    } else if (type === 'gemini') {
      const parts = [];
      if (t.text.trim()) parts.push({ text: t.text });
      // Calls made by another model carry no Gemini thought signature; this documented placeholder lets Gemini accept them.
      for (const c of t.calls) parts.push({ functionCall: { name: c.name, args: c.args }, thoughtSignature: 'skip_thought_signature_validator' });
      out.push({ role: 'model', parts });
    } else {
      const msg = { role: 'assistant', content: t.text || null };
      if (t.calls.length) msg.tool_calls = t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      if (keepReasoning && t.calls.length) msg.reasoning_content = t.thoughts || ' ';
      out.push(msg);
    }
  }
  return out;
}

export function convertHistory(fromProvider, toProvider, history) {
  if (!history.length || fromProvider === toProvider) return history;
  return fromNeutral(toProvider, toNeutral(typeOf(fromProvider), history));
}

const CONTINUE_TEXT = 'The previous model stopped because it hit its usage limit. You are taking over this task: review the conversation and tool results above, then continue the work from where it stopped. Do not redo steps that already succeeded.';

async function readMemory(session) {
  if (session.kind !== 'local') return '';
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    try { if (await desktop.exists(session.root, name)) return await desktop.read(session.root, name); } catch {}
  }
  return '';
}

// ---------- agent loop ----------
// opts.handoff: continue after another provider hit its limit (no user bubble, a "take over" instruction instead).
async function runAgent(session, text, opts = {}) {
  if (run) return;
  const provider = app.settings.provider;
  const model = currentModel(provider);
  if (!hasKey(provider)) { openSettings('keys'); toast(tr('{name} API 키를 먼저 입력하세요', { name: providerInfo(provider).name })); return; }
  if (session.kind === 'local' && !desktop) { toast(tr('내 PC 폴더 세션은 데스크톱 앱에서만 열 수 있습니다')); return; }
  if (session.historyProvider && session.historyProvider !== provider && session.history.length) {
    try {
      session.history = convertHistory(session.historyProvider, provider, session.history);
      session.log.push({ id: uid(), type: 'info', text: tr('지금까지의 작업 내용을 {model} 모델에게 넘겨 이어서 진행합니다.', { model: modelLabel(model) }) });
    } catch (e) {
      console.error('history conversion failed', e);
      session.history = [];
      session.log.push({ id: uid(), type: 'info', text: tr('공급자가 바뀌어 대화 맥락을 새로 시작합니다. (파일은 유지됩니다)') });
    }
  }
  session.historyProvider = provider;
  if (!opts.handoff) session.log.push({ id: uid(), type: 'user', text });
  session.history.push(nativeUser(provider, opts.handoff ? CONTINUE_TEXT : text));
  if (session.title === tr('새 세션')) {
    session.title = text.slice(0, 40);
    emit('code');
    if (view?.sessionId === session.id) view.titleBtn.firstChild.textContent = session.title;
  }
  run = { sessionId: session.id, ctrl: new AbortController(), stop: false };
  renderAll();

  const MAX_STEPS = 60;
  let limited = false;
  try {
    const memory = await readMemory(session);
    for (let step = 0; step < MAX_STEPS && !run.stop; step++) {
      const mode = app.settings.codeMode;
      const resp = await postJSON('/api/agent', provider, {
        provider, model, tools: toolsFor(session, mode), history: session.history,
        system: systemPrompt(session, mode, memory), thinking: app.settings.tools.thinking,
      }, run.ctrl.signal);
      session.history.push(resp.native);
      session.usage.input += resp.usage?.input || 0;
      session.usage.output += resp.usage?.output || 0;
      recordUsage(provider, resp.usage);
      recordLimits(provider, resp.limits);
      if (resp.thoughts?.trim()) session.log.push({ id: uid(), type: 'thought', text: resp.thoughts });
      if (resp.text?.trim()) session.log.push({ id: uid(), type: 'assistant', text: resp.text, plan: mode === 'plan' && !resp.toolCalls.length });
      renderLog();
      if (!resp.toolCalls.length) break;

      const results = [];
      for (const call of resp.toolCalls) {
        const entry = { id: uid(), type: 'tool', name: call.name, args: call.args || {}, status: 'running' };
        session.log.push(entry);
        renderLog();
        let output;
        if (run.stop) { output = 'Interrupted by the user before running.'; entry.status = 'denied'; entry.summary = tr('중단됨'); }
        else if (mode === 'plan' && !READ_ONLY.has(call.name)) { output = 'Not allowed in plan mode.'; entry.status = 'denied'; entry.summary = tr('계획 모드에서는 실행할 수 없음'); }
        else {
          output = await execTool(session, call, entry);
          if (entry.status === 'running' || entry.status === 'awaiting') entry.status = 'done';
        }
        results.push({ callId: call.id, name: call.name, output: String(output).slice(0, 30000) });
        save(session);
        renderLog();
      }
      session.history.push(...nativeResults(provider, results));
      if (step === MAX_STEPS - 1) session.log.push({ id: uid(), type: 'info', text: tr('최대 단계({n})에 도달해 멈췄습니다. "계속"이라고 입력하면 이어서 진행합니다.', { n: MAX_STEPS }) });
    }
  } catch (e) {
    if (e.name === 'AbortError') session.log.push({ id: uid(), type: 'info', text: tr('사용자가 중단했습니다.') });
    else {
      session.log.push({ id: uid(), type: 'error', text: e.message, limit: e.limit || null, provider });
      if (e.limit) { limited = true; recordLimitError(provider, e); }
    }
  } finally {
    const last = session.log.at(-1);
    if (run?.stop && !(last?.type === 'info' && last.text === tr('사용자가 중단했습니다.'))) session.log.push({ id: uid(), type: 'info', text: tr('사용자가 중단했습니다.') });
    run = null;
    save(session);
    emit('code');
    renderAll();
    schedulePreview();
  }
  // Limit reached: let another AI take over the same task with the full history.
  if (limited && app.settings.autoSwitch && (opts.handoffs || 0) < 3) {
    const next = fallbackCandidates(provider)[0];
    if (next) {
      switchTo(next.provider);
      session.log.push({ id: uid(), type: 'info', text: tr('{from} 한도에 걸려 {to} 모델로 자동 전환합니다.', { from: providerInfo(provider).name, to: modelLabel(next.model) }) });
      await runAgent(session, '', { handoff: true, handoffs: (opts.handoffs || 0) + 1 });
    }
  }
}

function stopAgent() {
  if (!run) return;
  run.stop = true;
  run.ctrl.abort();
  for (const resolve of approvals.values()) resolve('deny');
  desktop?.killForeground().catch(() => {});
}

// ---------- rendering ----------
const short = (s, n = 70) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const TOOL_LABEL = {
  list_files: (a) => ['List', a.dir || '.'], read_file: (a) => ['Read', a.path], write_file: (a) => ['Write', a.path],
  edit_file: (a) => ['Update', a.path], delete_file: (a) => ['Delete', a.path], grep: (a) => ['Search', a.pattern],
  run_javascript: () => ['Run', 'JavaScript'], todo_write: () => ['Update Todos', ''],
  run_command: (a) => [a.background ? tr('Shell (백그라운드)') : 'Shell', short(a.command)], process_output: (a) => ['Output', a.id], kill_process: (a) => ['Kill', a.id],
};

function diffEl(diff) {
  return h('div', { class: 'diff' }, diff.map((d) => h('div', { class: 'dl ' + (d.t === '+' ? 'add' : d.t === '-' ? 'del' : d.t === '…' ? 'more' : '') },
    h('span', { class: 'dn' }, d.n ? String(d.n) : ''), h('span', { class: 'dt' }, d.t === '…' ? '' : d.t), h('span', { class: 'ds' }, d.s))));
}

function todoList(todos) {
  return h('div', { class: 'todo-list' }, todos.map((t) => h('div', { class: 'todo ' + t.status },
    h('span', { class: 'tbox', html: t.status === 'completed' ? icon('check', 13) : '' }), h('span', {}, t.content))));
}

function codeBlock(text, lang) {
  const code = h('code', { class: lang ? 'language-' + lang : '' });
  code.textContent = text;
  if (lang) { try { hljs.highlightElement(code); } catch {} }
  return h('pre', { class: 'tool-code' }, code);
}

function entryEl(session, e) {
  if (e.type === 'user') return h('div', { class: 'ce user' }, h('span', { class: 'prompt-mark' }, '>'), h('div', { class: 'ce-text' }, e.text));
  if (e.type === 'info') return h('div', { class: 'ce info' }, e.text);
  if (e.type === 'error') {
    const session = view && getSession(view.sessionId);
    const isLast = session?.log.at(-1)?.id === e.id;
    return h('div', { class: 'ce error' }, h('span', { class: 'dot err' }), h('div', {}, tr('오류: ') + e.text,
      e.limit && isLast && !run ? switchActions(e.provider, () => runAgent(session, '', { handoff: true })) : null));
  }
  if (e.type === 'thought') return h('details', { class: 'ce thought' }, h('summary', {}, h('span', { html: icon('spark', 13) }), tr('생각 과정')), renderMarkdown(e.text));
  if (e.type === 'assistant') {
    const el = h('div', { class: 'ce assistant' }, h('span', { class: 'dot' }), renderMarkdown(e.text));
    if (e.plan && !run && session.log.at(-1) === e) {
      const go = (mode) => { app.settings.codeMode = mode; persist('settings'); renderModeBtn(); runAgent(session, tr('좋아요. 이 계획대로 진행해 주세요.')); };
      el.append(h('div', { class: 'plan-actions' },
        h('button', { class: 'btn primary sm', onclick: () => go('auto') }, tr('계획 승인 · 자동 편집으로 진행')),
        h('button', { class: 'btn sm', onclick: () => go('ask') }, tr('승인 · 편집마다 확인')),
        h('button', { class: 'btn ghost sm', onclick: () => view?.input.focus() }, tr('계획 수정 요청'))));
    }
    return el;
  }
  const [label, arg] = (TOOL_LABEL[e.name] || (() => [e.name, '']))(e.args || {});
  const el = h('div', { class: 'ce tool ' + e.status },
    h('div', { class: 'tool-head' }, h('span', { class: 'dot' }), h('b', {}, label), arg ? h('span', { class: 'targ' }, '(' + arg + ')') : null));
  const body = [];
  if (e.todos) body.push(todoList(e.todos));
  else if (e.summary) body.push(h('span', { class: 'tsum' }, e.summary));
  else if (e.status === 'running') body.push(h('span', { class: 'tsum muted' }, tr('실행 중...')));
  if (e.name === 'run_javascript') body.push(codeBlock(e.args.code || '', 'javascript'));
  if (e.name === 'run_command' && String(e.args.command || '').length > 70) body.push(codeBlock(e.args.command, 'powershell'));
  if (e.output) body.push(h('pre', { class: 'tool-out' }, e.output.length > 6000 ? '…' + e.output.slice(-6000) : e.output));
  if (e.diff && e.status !== 'denied') body.push(diffEl(e.diff));
  el.append(h('div', { class: 'tool-body' }, h('span', { class: 'elbow' }, '⎿'), h('div', { class: 'tb-content' }, body)));

  if (e.status === 'awaiting') {
    const fb = h('input', { type: 'text', placeholder: tr('거부할 때 AI에게 전할 말 (선택)') });
    const decide = (d) => { if (d === 'deny') e.feedback = fb.value.trim(); approvals.get(e.id)?.(d); };
    const what = {
      run_javascript: tr('이 코드를 실행할까요?'), run_command: tr('이 명령을 실행할까요?'), kill_process: tr('이 프로세스를 중지할까요?'),
      delete_file: tr('{p} 파일을 삭제할까요?', { p: arg }),
    }[e.name] || tr('{p} 파일을 변경할까요?', { p: arg });
    el.append(h('div', { class: 'approval' },
      h('b', {}, what),
      e.name === 'run_command' ? h('code', { class: 'appr-cmd' }, e.args.command) : null,
      h('div', { class: 'appr-btns' },
        h('button', { class: 'appr', onclick: () => decide('allow') }, h('kbd', {}, '1'), tr('예')),
        h('button', { class: 'appr', onclick: () => decide('always') }, h('kbd', {}, '2'), tr('예, 이후에는 묻지 않기 (자동 수락)')),
        h('button', { class: 'appr', onclick: () => decide('deny') }, h('kbd', {}, '3'), tr('아니요'))),
      fb));
  }
  return el;
}

function welcomeEl(session) {
  const local = session.kind === 'local';
  const examples = local
    ? [tr('이 프로젝트 구조를 살펴보고 설명해줘'), '/init', tr('Vite + React 프로젝트를 만들고 개발 서버를 실행해줘'), tr('테스트를 실행하고 실패하는 것을 고쳐줘')]
    : [tr('간단한 할 일 목록 앱을 만들어줘 (추가, 완료, 삭제, 로컬 저장)'), tr('현재 파일들을 살펴보고 구조를 설명해줘'), tr('반응형 랜딩 페이지를 만들어줘'), tr('숫자 맞추기 게임을 만들어줘')];
  return h('div', { class: 'code-welcome' },
    h('div', { class: 'cw-box' },
      h('div', { class: 'cw-title' }, h('span', { class: 'cw-logo', html: icon('logo', 18) }), h('b', {}, tr('Code 모드')), h('span', { class: 'muted' }, local ? tr(' · 내 PC 폴더에서 작업') : tr(' · 브라우저 작업 공간'))),
      h('div', { class: 'muted small' }, tr('/help 도움말 · Shift+Tab 모드 전환 · Esc 중단')),
      h('div', { class: 'muted small' }, local ? tr('작업 폴더: ') + session.root : tr('작업 공간: {n}개 파일', { n: Object.keys(session.files).length }))),
    h('div', { class: 'cw-tips' }, h('div', { class: 'muted small' }, tr('이렇게 시작해 보세요:')),
      examples.map((t) => h('button', { class: 'cw-ex', onclick: () => { view.input.value = t; view.input.focus(); autoGrow(); } }, '> ' + t))));
}

function renderLog() {
  if (!view) return;
  const session = getSession(view.sessionId);
  if (!session) return;
  const s = view.logScroll;
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 200;
  view.log.replaceChildren(...(session.log.length ? session.log.map((e) => entryEl(session, e)) : [welcomeEl(session)]));
  if (run?.sessionId === session.id && !session.log.some((e) => e.status === 'awaiting')) {
    view.log.append(h('div', { class: 'ce working' }, h('span', { class: 'spin', html: icon('spark', 14) }), h('span', {}, tr('작업 중... ')), h('span', { class: 'muted' }, tr('(Esc로 중단)'))));
  }
  if (near || run) s.scrollTop = s.scrollHeight;
  renderTodos();
  renderStatus();
}

function renderTodos() {
  if (!view) return;
  const todos = getSession(view.sessionId)?.todos || [];
  const active = todos.length && todos.some((t) => t.status !== 'completed');
  view.todos.hidden = !active;
  if (active) view.todos.replaceChildren(h('div', { class: 'todos-head' }, h('b', {}, tr('할 일')), h('span', { class: 'muted' }, todos.filter((t) => t.status === 'completed').length + ' / ' + todos.length)), todoList(todos));
}

function renderStatus() {
  if (!view) return;
  const session = getSession(view.sessionId);
  view.status.textContent = tr('토큰 {n}', { n: (session.usage.input + session.usage.output).toLocaleString() }) + ' · ' + modelLabel(currentModel());
  view.sendBtn.innerHTML = icon(run ? 'stop' : 'up', 16);
  view.sendBtn.title = run ? tr('중단 (Esc)') : tr('보내기');
}

function renderModeBtn() {
  if (!view) return;
  const m = MODES.find((x) => x.id === app.settings.codeMode) || MODES[0];
  view.modeBtn.className = 'mode-btn mode-' + m.id;
  view.modeBtn.innerHTML = '<span class="mode-dot"></span><span>' + esc(m.label) + '</span>';
  view.modeBtn.title = m.desc + tr(' (Shift+Tab으로 전환)');
}

function cycleMode() {
  const i = MODES.findIndex((x) => x.id === app.settings.codeMode);
  app.settings.codeMode = MODES[(i + 1) % MODES.length].id;
  persist('settings');
  renderModeBtn();
}

function autoGrow() {
  if (!view) return;
  view.input.style.height = 'auto';
  view.input.style.height = Math.min(view.input.scrollHeight, 220) + 'px';
}

// ---------- workspace ----------
function sortPaths(paths) {
  return paths.sort((a, b) => {
    const da = a.includes('/'), db = b.includes('/');
    return da === db ? a.localeCompare(b) : da ? -1 : 1;
  });
}

let filesSeq = 0;
async function renderFiles() {
  if (!view) return;
  const session = getSession(view.sessionId);
  const fs = fsFor(session);
  const seq = ++filesSeq;
  let list;
  try { list = (await fs.list('')).files.map((f) => f.path); } catch (e) {
    view.fileList.replaceChildren(h('div', { class: 'empty small' }, e.message));
    return;
  }
  if (seq !== filesSeq || !view) return;
  const paths = sortPaths(list);
  if (view.selected && !paths.includes(view.selected)) view.selected = null;
  if (!view.selected) view.selected = paths.includes('index.html') ? 'index.html' : paths.find((p) => !p.includes('/')) || paths[0] || null;
  view.fileList.replaceChildren(...paths.map((p) => {
    const depth = p.split('/').length - 1;
    return h('button', {
      class: 'file-item' + (p === view.selected ? ' on' : '') + (p === view.flash ? ' flash' : ''),
      style: { paddingLeft: 10 + Math.min(depth, 6) * 12 + 'px' }, title: p,
      onclick: () => { view.selected = p; renderFiles(); },
    }, h('span', { html: icon('file', 14) }), h('span', { class: 'fname' }, p.split('/').pop()), depth ? h('small', { class: 'muted fdir' }, p.split('/').slice(0, -1).join('/')) : '');
  }));
  if (!paths.length) view.fileList.append(h('div', { class: 'empty small' }, tr('파일이 없습니다')));
  view.flash = null;
  await loadEditor(session);
}

async function loadEditor(session) {
  const p = view.selected;
  view.editorPath.textContent = p || tr('파일을 선택하세요');
  view.editorDel.hidden = !p;
  if (document.activeElement === view.editor && view.editor.dataset.path === p) return;
  if (!p) { view.editor.value = ''; view.editor.dataset.path = ''; view.editor.disabled = true; return; }
  try {
    const content = await fsFor(session).read(p);
    if (view.selected !== p) return;
    view.editor.value = content;
    view.editor.disabled = false;
  } catch (e) {
    view.editor.value = '(' + e.message + ')';
    view.editor.disabled = true;
  }
  view.editor.dataset.path = p;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 350);
}

async function workspaceDoc(fs, paths) {
  const entry = paths.includes('index.html') ? 'index.html' : paths.find((p) => p.endsWith('.html'));
  if (!entry) return null;
  let html = await fs.read(entry);
  const read = async (ref) => { const p = normPath(ref); if (!paths.includes(p)) return null; try { return await fs.read(p); } catch { return null; } };
  const links = [...html.matchAll(/<link\b[^>]*?href=["']([^"']+)["'][^>]*>/gi)].filter((m) => /stylesheet/i.test(m[0]));
  for (const m of links) { const css = await read(m[1]); if (css != null) html = html.replace(m[0], () => '<style>\n' + css + '\n</style>'); }
  const scripts = [...html.matchAll(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi)];
  for (const m of scripts) { const js = await read(m[2]); if (js != null) html = html.replace(m[0], () => '<script' + m[1] + m[3] + '>\n' + js.replace(/<\/script/gi, '<\\/script') + '\n</script>'); }
  return html;
}

async function renderPreview() {
  if (!view || view.wsTab !== 'preview') return;
  const session = getSession(view.sessionId);
  const url = view.urlInput?.value.trim();
  if (url) {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) { toast(tr('localhost 주소만 열 수 있습니다')); return; }
    const f = h('iframe', { class: 'ws-frame', src: url, sandbox: 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups' });
    view.previewBox.replaceChildren(f);
    return;
  }
  const fs = fsFor(session);
  let doc = null;
  try { doc = await workspaceDoc(fs, (await fs.list('')).files.map((f) => f.path)); } catch {}
  if (!view) return;
  view.previewBox.replaceChildren(doc ? sandboxFrame(doc, 'ws-frame') : h('div', { class: 'empty' }, session.kind === 'local' ? tr('index.html이 없으면 위 주소창에 개발 서버 주소(예: http://localhost:5173)를 입력하세요.') : tr('index.html 파일이 있으면 여기에 미리보기가 표시됩니다.')));
}

function setWsTab(tab) {
  view.wsTab = tab;
  view.wsTabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  view.filesPane.hidden = tab !== 'files';
  view.previewWrap.hidden = tab !== 'preview';
  if (tab === 'preview') renderPreview();
}

async function uploadFiles(session, list) {
  const fs = fsFor(session);
  let n = 0, skipped = 0;
  for (const f of Array.from(list)) {
    const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    if (!isTextFile({ name: f.name, mimeType: f.type }) || f.size > 2 * 1024 * 1024 || /(^|\/)(node_modules|\.git)\//.test(rel)) { skipped++; continue; }
    try { await fs.write(checkPath(rel), await f.text()); n++; } catch { skipped++; }
  }
  save(session);
  renderFiles();
  schedulePreview();
  toast(tr('{n}개 파일을 추가했습니다', { n }) + (skipped ? tr(' ({n}개 건너뜀: 바이너리·대용량)', { n: skipped }) : ''));
}

async function downloadZip(session) {
  if (typeof JSZip === 'undefined') return toast(tr('ZIP 라이브러리를 불러오지 못했습니다'));
  const zip = new JSZip();
  Object.entries(session.files).forEach(([p, c]) => zip.file(p, c));
  downloadBlob((session.title || 'workspace').replace(/[\\/:*?"<>|]+/g, '_') + '.zip', await zip.generateAsync({ type: 'blob' }));
}

// ---------- slash commands ----------
async function slash(session, text) {
  const [cmd] = text.split(/\s+/);
  const info = (t) => { session.log.push({ id: uid(), type: 'info', text: t }); renderLog(); };
  switch (cmd) {
    case '/clear':
      session.history = []; session.log = []; session.todos = [];
      save(session); renderAll(); toast(tr('대화를 지웠습니다 (파일은 유지)'));
      return true;
    case '/help':
      info(tr('명령어: /init 프로젝트 메모(AGENTS.md) 만들기 · /clear 대화 지우기 · /cost 토큰 사용량 · /model 모델 선택 · /files 파일 목록') + (session.kind === 'local' ? tr(' · /ps 백그라운드 프로세스') : '') + tr(' · /help 도움말\n단축키: Enter 보내기 · Shift+Enter 줄바꿈 · Shift+Tab 모드 전환(편집 전 확인 → 자동 수락 → 계획) · Esc 중단 · 1/2/3 승인 응답'));
      return true;
    case '/cost':
      info(tr('이 세션 토큰 사용량: 입력 {i} · 출력 {o}', { i: session.usage.input.toLocaleString(), o: session.usage.output.toLocaleString() }));
      return true;
    case '/files': {
      const { files } = await fsFor(session).list('');
      info(files.map((f) => f.path + ' (' + kb(f.size) + ')').join('\n') || tr('(파일 없음)'));
      return true;
    }
    case '/ps': {
      if (!desktop) return info(tr('데스크톱 앱에서만 사용할 수 있습니다.')), true;
      const ps = await desktop.processes();
      info(ps.length ? ps.map((p) => p.id + ' · ' + (p.running ? tr('실행 중') : tr('종료({code})', { code: p.exitCode })) + ' · ' + p.command).join('\n') : tr('실행 중인 백그라운드 프로세스가 없습니다.'));
      return true;
    }
    case '/model':
      openModelPicker(view.status);
      return true;
    case '/init':
      runAgent(session, tr('Analyze this project and create (or update) an AGENTS.md file in the project root. Include: a short overview, the directory structure, how to install/build/run/test, coding conventions you observe, and anything a future coding agent should know. Keep it concise. 설명은 한국어로 해줘.'));
      return true;
  }
  if (cmd.startsWith('/')) { toast(tr('알 수 없는 명령어입니다. /help 를 입력하세요')); return true; }
  return false;
}

// ---------- views ----------
function topbar(...children) {
  return h('header', { class: 'topbar' }, h('button', { class: 'icon-btn mobile-only', html: icon('menu'), onclick: () => document.body.classList.add('sidebar-open') }), ...children, usageButton());
}

async function openLocalFolder(text) {
  if (!desktop) return;
  const picked = await desktop.pickFolder().catch((e) => { toast(e.message); return null; });
  if (!picked) return;
  const s = newSession(picked.name, { kind: 'local', root: picked.root });
  location.hash = '#/code/' + s.id;
  if (text) setTimeout(() => runAgent(s, text), 80);
}

export function renderCodeHome(container) {
  closeArtifact();
  view = null;
  const ta = h('textarea', { rows: 3, placeholder: desktop ? tr('무엇을 만들거나 고칠까요? 먼저 작업할 폴더를 선택합니다.') : tr('무엇을 만들거나 고칠까요? 예: 메모 앱을 만들어줘') });
  const starter = h('select', {},
    desktop ? h('option', { value: 'local' }, tr('내 PC 폴더에서 작업...')) : null,
    h('option', { value: 'empty' }, tr('브라우저 작업 공간 (빈 상태)')),
    h('option', { value: 'html' }, tr('브라우저 작업 공간 (HTML 스타터)')));
  const start = () => {
    const text = ta.value.trim();
    if (starter.value === 'local') { openLocalFolder(text); return; }
    const s = newSession(tr('새 세션'), { files: starter.value === 'html' ? { ...STARTER } : {} });
    location.hash = '#/code/' + s.id;
    if (text) setTimeout(() => runAgent(s, text), 50);
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); start(); } });
  const sessions = [...app.code].sort((a, b) => b.updatedAt - a.updatedAt);
  container.replaceChildren(h('div', { class: 'page' },
    topbar(h('h2', { class: 'page-title' }, 'Code')),
    h('div', { class: 'page-inner' },
      h('div', { class: 'code-hero' },
        h('h1', {}, h('span', { class: 'g-logo', html: icon('terminal', 30) }), tr('무엇을 만들어 볼까요?')),
        h('p', { class: 'muted' }, desktop
          ? tr('AI 에이전트가 내 PC 폴더에서 파일을 읽고 수정하고, 터미널 명령(npm, python, git, 테스트 등)을 실행합니다.')
          : tr('AI 에이전트가 브라우저 속 작업 공간에서 파일을 읽고, 만들고, 수정합니다. 내 PC 폴더와 터미널은 데스크톱 앱에서 사용할 수 있습니다.')),
        h('div', { class: 'code-start' }, ta, h('div', { class: 'row' }, starter, h('div', { class: 'spacer' }),
          desktop ? h('button', { class: 'btn', onclick: () => openLocalFolder(ta.value.trim()), html: icon('folder', 16) + '<span>' + esc(tr('폴더 열기')) + '</span>' }) : null,
          h('button', { class: 'btn primary', onclick: start }, tr('세션 시작'))))),
      h('h3', { class: 'section-title' }, tr('최근 세션')),
      h('div', { class: 'chat-rows' }, sessions.length ? sessions.map((s) => h('div', { class: 'list-row' },
        h('a', { href: '#/code/' + s.id }, h('b', {}, s.kind === 'local' ? h('span', { class: 'r-icon', html: icon('folder', 14) }) : null, s.title),
          h('small', { class: 'muted' }, (s.kind === 'local' ? s.root : tr('{n}개 파일 · 브라우저', { n: Object.keys(s.files).length })) + ' · ' + timeAgo(s.updatedAt))),
        iconBtn('trash', tr('세션 삭제'), async () => {
          if (!(await confirmDialog(tr('"{title}" 세션을 삭제할까요?', { title: s.title }) + (s.kind === 'local' ? tr(' (PC의 파일은 지워지지 않습니다)') : tr(' 작업 공간 파일도 함께 지워집니다.')), { okLabel: tr('삭제'), danger: true }))) return;
          app.code = app.code.filter((x) => x.id !== s.id); persist('code'); emit('code'); renderCodeHome(container);
        }))) : h('div', { class: 'empty small' }, tr('아직 세션이 없습니다.'))))));
  ta.focus();
}

export function renderCodeSession(container, id) {
  closeArtifact();
  const session = getSession(id);
  if (!session) { location.hash = '#/code'; return; }
  session.kind = session.kind || 'browser';
  const local = session.kind === 'local';

  const input = h('textarea', { rows: 1, class: 'code-input', placeholder: tr('무엇을 할까요? ( /help )') });
  const sendBtn = h('button', { class: 'send-btn sm' });
  const modeBtn = h('button', { class: 'mode-btn', onclick: cycleMode });
  const status = h('button', { class: 'code-status', onclick: (e) => openModelPicker(e.currentTarget) });
  const log = h('div', { class: 'code-log' });
  const logScroll = h('div', { class: 'code-scroll' }, log);
  const todos = h('div', { class: 'code-todos', hidden: true });

  const fileList = h('div', { class: 'file-list' });
  const editorPath = h('span', { class: 'ed-path' });
  const editor = h('textarea', { class: 'editor', spellcheck: 'false', wrap: 'off' });
  let editTimer = null;
  editor.addEventListener('input', () => {
    const p = editor.dataset.path;
    if (!p) return;
    const content = editor.value;
    clearTimeout(editTimer);
    editTimer = setTimeout(async () => {
      try { await fsFor(session).write(p, content); save(session); schedulePreview(); } catch (e) { toast(tr('저장 실패: ') + e.message); }
    }, 400);
  });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('  ', s, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); }
  });
  const editorDel = iconBtn('trash', tr('파일 삭제'), async () => {
    const p = editor.dataset.path;
    if (!p || !(await confirmDialog(tr('{p} 파일을 삭제할까요?', { p }), { okLabel: tr('삭제'), danger: true }))) return;
    try { await fsFor(session).remove(p); } catch (e) { toast(e.message); }
    save(session); renderFiles(); schedulePreview();
  });
  const upInput = h('input', { type: 'file', multiple: true, hidden: true });
  const dirInput = h('input', { type: 'file', multiple: true, hidden: true, webkitdirectory: true });
  upInput.addEventListener('change', () => { uploadFiles(session, upInput.files); upInput.value = ''; });
  dirInput.addEventListener('change', () => { uploadFiles(session, dirInput.files); dirInput.value = ''; });
  const newFile = async () => {
    const p = await promptDialog(tr('새 파일 경로'), '', { placeholder: tr('예: src/utils.js') });
    if (!p) return;
    try { const path = checkPath(p); const fs = fsFor(session); if (!(await fs.exists(path))) await fs.write(path, ''); view.selected = path; save(session); renderFiles(); } catch (e) { toast(e.message); }
  };
  const addMenu = iconBtn('plus', tr('파일 추가'), () => popover(addMenu, h('div', { class: 'menu' },
    menuItem('file', tr('새 파일'), newFile),
    local ? null : menuItem('upload', tr('파일 업로드'), () => upInput.click()),
    local ? null : menuItem('folder', tr('폴더 업로드'), () => dirInput.click()))));

  const wsTabs = h('div', { class: 'seg' },
    h('button', { 'data-tab': 'files', onclick: () => setWsTab('files') }, tr('파일')),
    h('button', { 'data-tab': 'preview', onclick: () => setWsTab('preview') }, tr('미리보기')));
  const filesPane = h('div', { class: 'files-pane' }, fileList, h('div', { class: 'editor-wrap' }, h('div', { class: 'ed-head' }, editorPath, editorDel), editor));
  const urlInput = local ? h('input', { type: 'text', class: 'url-input', placeholder: tr('index.html 미리보기 · 또는 http://localhost:5173 입력 후 Enter') }) : null;
  urlInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') renderPreview(); });
  const previewBox = h('div', { class: 'preview-box' });
  const previewWrap = h('div', { class: 'preview-wrap', hidden: true }, urlInput, previewBox);
  const wsPanel = h('section', { class: 'ws-panel' },
    h('div', { class: 'ws-head' }, wsTabs, h('div', { class: 'spacer' }), addMenu,
      iconBtn('refresh', tr('새로고침'), () => { renderFiles(); renderPreview(); }),
      local ? iconBtn('folder', tr('탐색기에서 열기'), () => desktop.reveal(session.root).catch((e) => toast(e.message))) : iconBtn('download', tr('ZIP 다운로드'), () => downloadZip(session)),
      upInput, dirInput),
    filesPane, previewWrap);

  const titleBtn = h('button', { class: 'chat-title', onclick: async () => {
    const t = await promptDialog(tr('세션 이름'), session.title);
    if (t?.trim()) { session.title = t.trim(); save(session); emit('code'); titleBtn.firstChild.textContent = session.title; }
  } }, h('span', {}, session.title), h('span', { html: icon('edit', 13) }));

  const split = h('div', { class: 'code-split' },
    h('section', { class: 'code-main' }, logScroll, todos,
      h('div', { class: 'code-composer' },
        h('div', { class: 'cc-input' }, h('span', { class: 'prompt-mark' }, '>'), input, sendBtn),
        h('div', { class: 'cc-bar' }, modeBtn, local ? h('span', { class: 'cwd', title: session.root }, session.root) : null, h('div', { class: 'spacer' }), status))),
    wsPanel);
  const wsToggle = iconBtn('sidebar', tr('작업 공간 패널'), () => split.classList.toggle('ws-hidden'));
  container.replaceChildren(h('div', { class: 'code-view' }, topbar(h('a', { class: 'crumb', href: '#/code' }, h('span', { html: icon('terminal', 15) }), 'Code', h('span', { class: 'sep' }, '/')), titleBtn, h('div', { class: 'spacer' }), wsToggle), split));
  if (window.innerWidth < 900) split.classList.add('ws-hidden');

  view = { sessionId: id, titleBtn, log, logScroll, todos, input, sendBtn, modeBtn, status, fileList, editor, editorPath, editorDel, wsTabs, filesPane, previewBox, previewWrap, urlInput, wsTab: 'files', selected: null, flash: null };

  if (local && !desktop) {
    session.log.length || session.log.push({ id: uid(), type: 'info', text: tr('이 세션은 내 PC 폴더를 사용합니다. 데스크톱 앱에서 열어 주세요.') });
  }

  const submit = async () => {
    if (run) { stopAgent(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow();
    if (await slash(session, text)) return;
    runAgent(session, text);
  };
  sendBtn.addEventListener('click', submit);
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); }
  });

  renderModeBtn();
  setWsTab('files');
  renderAll();
  input.focus();
}

function renderAll() { renderLog(); renderFiles(); renderModeBtn(); }

export function leaveCode() { view = null; }

document.addEventListener('keydown', (e) => {
  if (!view) return;
  if (e.key === 'Escape' && run && !document.querySelector('dialog[open]')) { e.preventDefault(); stopAgent(); return; }
  const session = getSession(view.sessionId);
  const pending = session?.log.find((x) => x.status === 'awaiting');
  const tag = document.activeElement?.tagName;
  if (pending && ['1', '2', '3'].includes(e.key) && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    approvals.get(pending.id)?.({ 1: 'allow', 2: 'always', 3: 'deny' }[e.key]);
  }
});
