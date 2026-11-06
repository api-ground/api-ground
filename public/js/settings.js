import { app, persist, emit } from './state.js';
import { h, modal, toast, toggleSwitch, confirmDialog, downloadBlob, iconBtn } from './ui.js';
import { loadModels, brandImg } from './api.js';
import { t as tr, LANGUAGES, langSetting, setLanguage } from './i18n.js';
import { accountTab } from './account.js';
import { usageTab } from './usage.js';

export function applyTheme() {
  const theme = app.settings.theme;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  document.body.classList.toggle('font-sans', app.settings.font === 'sans');
  document.body.classList.toggle('font-system', app.settings.font === 'system');
  window.desktop?.setTheme?.(theme).catch(() => {});
}

export const THEMES = [['system', tr('시스템 설정')], ['light', tr('밝은 화면')], ['dark', tr('어두운 화면')]];

export function setTheme(v) {
  app.settings.theme = v;
  persist('settings');
  emit('settings');
  applyTheme();
}

function themePicker() {
  const wrap = h('div', { class: 'theme-cards' });
  const draw = () => wrap.replaceChildren(...THEMES.map(([v, label]) => h('button', {
    type: 'button', class: 'theme-card' + (app.settings.theme === v ? ' on' : ''),
    onclick: () => { setTheme(v); draw(); },
  }, h('span', { class: 'tc-preview tc-' + v }, h('span', { class: 'tc-side' }), h('span', { class: 'tc-main' }, h('span', { class: 'tc-line' }), h('span', { class: 'tc-line short' }), h('span', { class: 'tc-dot' }))), h('span', { class: 'tc-label' }, label))));
  draw();
  return wrap;
}

function languagePicker() {
  const sel = h('select', { class: 'lang-select' }, LANGUAGES.map((l) => h('option', { value: l.id }, l.label || tr('시스템 언어 따르기'))));
  sel.value = langSetting();
  sel.addEventListener('change', () => setLanguage(sel.value));
  return sel;
}

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}

function seg(options, value, onchange) {
  const wrap = h('div', { class: 'seg' });
  options.forEach(([v, label]) => wrap.append(h('button', {
    class: v === value ? 'on' : '', type: 'button',
    onclick: () => { wrap.querySelectorAll('button').forEach((b) => b.classList.remove('on')); wrap.querySelector('[data-v="' + v + '"]').classList.add('on'); onchange(v); },
    'data-v': v,
  }, label)));
  return wrap;
}

function save() { persist('settings'); emit('settings'); }

function generalTab() {
  const s = app.settings;
  const name = h('input', { type: 'text', value: s.name, placeholder: tr('예: 지민') });
  name.addEventListener('input', () => { s.name = name.value.trim(); save(); });
  const prefs = h('textarea', { rows: 5, placeholder: tr('예: 저는 백엔드 개발자이고 Go를 주로 씁니다. 답변은 한국어로, 예제 코드를 포함해 주세요.') });
  prefs.value = s.preferences;
  prefs.addEventListener('input', () => { s.preferences = prefs.value; save(); });
  return h('div', { class: 'form' },
    field(tr('이름'), name, tr('AI가 당신을 이렇게 부릅니다.')),
    field(tr('AI가 응답할 때 고려할 개인 선호'), prefs, tr('모든 채팅의 시스템 프롬프트에 포함됩니다.')),
    field(tr('화면 테마'), themePicker()),
    field(tr('언어'), languagePicker(), tr('화면에 표시되는 언어입니다. AI는 질문한 언어로 답합니다.')),
    field(tr('응답 글꼴'), seg([['serif', tr('기본 (세리프)')], ['sans', tr('산세리프')], ['system', tr('시스템')]], s.font, (v) => { s.font = v; save(); applyTheme(); })),
  );
}

function featuresTab() {
  const s = app.settings;
  const row = (label, desc, value, set) => h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, label), h('small', { class: 'muted' }, desc)), toggleSwitch(value, (v) => { set(v); save(); }));
  return h('div', { class: 'form' },
    row(tr('아티팩트'), tr('코드, 문서, 웹앱, 다이어그램을 대화 옆 패널에 생성합니다.'), s.artifacts, (v) => { s.artifacts = v; }),
    row(tr('채팅 제목 자동 생성'), tr('첫 답변 후 대화 내용을 요약해 제목을 붙입니다 (추가 요청 1회).'), s.autoTitle, (v) => { s.autoTitle = v; }),
    row(tr('확장 사고'), tr('모델이 생각 과정을 함께 보여줍니다.'), s.tools.thinking, (v) => { s.tools.thinking = v; }),
    row(tr('웹 검색 (Gemini)'), tr('Google 검색 결과를 근거로 답하고 출처를 표시합니다.'), s.tools.search, (v) => { s.tools.search = v; }),
    s.customStyles.length ? h('div', {}, h('b', {}, tr('내 스타일')), h('div', { class: 'style-list' }, s.customStyles.map((st) => h('div', { class: 'style-item' },
      h('div', {}, h('b', {}, st.name), h('small', { class: 'muted' }, st.prompt)),
      iconBtn('trash', tr('삭제'), (e) => {
        s.customStyles = s.customStyles.filter((x) => x.id !== st.id);
        if (s.style === st.id) s.style = 'normal';
        save();
        e.currentTarget.closest('.style-item').remove();
      }))))) : null,
  );
}

function keysTab() {
  const s = app.settings;
  const els = [];
  if (app.config.passwordRequired) {
    const pw = h('input', { type: 'password', value: s.password, autocomplete: 'off' });
    pw.addEventListener('change', () => { s.password = pw.value; save(); app.models = {}; });
    els.push(field(tr('사이트 접근 비밀번호'), pw, tr('관리자가 설정한 비밀번호입니다.')));
  }
  const filter = h('input', { type: 'search', placeholder: tr('공급자 검색 (예: Claude, Grok, NVIDIA)') });
  const rows = app.config.providers.map((p) => {
    const input = h('input', { type: 'password', autocomplete: 'off', value: s.keys[p.id] || '', placeholder: p.serverKey ? tr('서버 키 사용 중 (비워두면 됨)') : tr('API 키 입력') });
    const status = h('span', { class: 'key-status' + (s.keys[p.id] || p.serverKey ? ' ok' : '') }, s.keys[p.id] ? tr('등록됨') : p.serverKey ? tr('서버 키') : '');
    input.addEventListener('change', () => {
      const v = input.value.trim();
      if (v) s.keys[p.id] = v; else delete s.keys[p.id];
      delete app.models[p.id];
      save();
      status.textContent = v ? tr('등록됨') : p.serverKey ? tr('서버 키') : '';
      status.classList.toggle('ok', Boolean(v || p.serverKey));
      loadModels(p.id).then(() => emit('settings'));
      toast(tr('{name} 키를 저장했습니다', { name: p.name }));
    });
    let baseInput = null;
    if (p.customBase) {
      baseInput = h('input', { type: 'text', value: s.bases?.[p.id] || '', placeholder: tr('사용자 지정 주소 (선택): https://<작업공간 ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1') });
      baseInput.addEventListener('change', () => {
        s.bases = s.bases || {};
        const v = baseInput.value.trim();
        if (v) s.bases[p.id] = v; else delete s.bases[p.id];
        delete app.models[p.id];
        save();
      });
    }
    return h('div', { class: 'key-row', 'data-q': (p.name + ' ' + p.company + ' ' + p.id).toLowerCase() },
      h('div', { class: 'kr-head' }, brandImg(p.icon, 22), h('div', { class: 'kr-name' }, h('b', {}, p.name), h('small', { class: 'muted' }, p.company)), status,
        p.keyUrl ? h('a', { class: 'kr-link', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, tr('키 발급')) : null),
      input, baseInput);
  });
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    rows.forEach((r) => { r.hidden = Boolean(q) && !r.dataset.q.includes(q); });
  });
  return h('div', { class: 'form' },
    h('p', { class: 'muted' }, window.desktop
      ? tr('키는 이 PC의 앱 데이터에만 저장되며, 앱에서 각 API로 직접 전달됩니다.')
      : tr('키는 이 브라우저에만 저장되며, 요청할 때 Cloudflare Worker를 거쳐 각 API로 전달됩니다.')),
    ...els, filter, h('div', { class: 'key-list' }, rows),
    h('p', { class: 'muted small' }, tr('NVIDIA NIM은 build.nvidia.com에서 무료 키를 받아 여러 오픈 모델을 체험할 수 있습니다.')));
}

function advancedTab() {
  const s = app.settings;
  const sys = h('textarea', { rows: 5, placeholder: tr('모든 채팅에 추가할 지침') });
  sys.value = s.systemPrompt;
  sys.addEventListener('input', () => { s.systemPrompt = sys.value; save(); });
  const num = (key, label, min, max, step, hint) => {
    const input = h('input', { type: 'number', min, max, step, placeholder: tr('모델 기본값') });
    if (s.params[key] != null) input.value = s.params[key];
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      s.params[key] = Number.isFinite(v) ? v : null;
      save();
    });
    return field(label, input, hint);
  };
  return h('div', { class: 'form' },
    field(tr('추가 시스템 프롬프트'), sys),
    h('div', { class: 'grid3' },
      num('temperature', 'Temperature', 0, 2, 0.05, tr('0~2, 비우면 기본값')),
      num('topP', 'Top P', 0, 1, 0.01, '0~1'),
      num('maxTokens', tr('최대 출력 토큰'), 1, 1000000, 1, tr('비우면 기본값'))),
  );
}

function dataTab() {
  const importInput = h('input', { type: 'file', accept: 'application/json', hidden: true });
  importInput.addEventListener('change', async () => {
    const f = importInput.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.chats)) throw new Error(tr('형식이 올바르지 않습니다'));
      if (!(await confirmDialog(tr('가져온 데이터를 현재 데이터에 합칠까요? (같은 ID는 덮어씁니다)')))) return;
      const merge = (key) => {
        const map = new Map(app[key].map((x) => [x.id, x]));
        (data[key] || []).forEach((x) => map.set(x.id, x));
        app[key] = [...map.values()];
        persist(key);
      };
      ['chats', 'projects', 'code'].forEach(merge);
      emit('chats');
      toast(tr('가져왔습니다'));
    } catch (e) { toast(tr('가져오기 실패: ') + e.message); }
  });
  return h('div', { class: 'form' },
    h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, tr('데이터 내보내기')), h('small', { class: 'muted' }, tr('채팅, 프로젝트, 코드 세션을 JSON 파일로 저장합니다. API 키는 포함되지 않습니다.'))),
      h('button', { class: 'btn', onclick: () => downloadBlob('api-ground-backup.json', new Blob([JSON.stringify({ chats: app.chats, projects: app.projects, code: app.code })], { type: 'application/json' })) }, tr('내보내기'))),
    h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, tr('데이터 가져오기')), h('small', { class: 'muted' }, tr('내보낸 JSON 파일을 불러옵니다.'))),
      h('button', { class: 'btn', onclick: () => importInput.click() }, tr('가져오기')), importInput),
    h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, tr('모든 채팅 삭제')), h('small', { class: 'muted' }, tr('프로젝트와 코드 세션은 유지됩니다.'))),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!(await confirmDialog(tr('모든 채팅을 삭제할까요? 되돌릴 수 없습니다.'), { okLabel: tr('모두 삭제'), danger: true }))) return;
        app.chats = []; persist('chats'); emit('chats'); location.hash = '#/'; toast(tr('삭제했습니다'));
      } }, tr('삭제'))),
  );
}

function memoryTab() {
  const s = app.settings;
  const list = h('div', { class: 'memory-list' });
  const draw = () => {
    list.replaceChildren(...(s.memories.length ? s.memories.map((m) => h('div', { class: 'memory-item' },
      h('span', {}, m.text),
      iconBtn('trash', tr('삭제'), () => { s.memories = s.memories.filter((x) => x.id !== m.id); save(); draw(); }))) : [h('div', { class: 'empty small' }, tr('아직 기억한 내용이 없습니다. 채팅에서 "이거 기억해줘"라고 말해 보세요.'))]));
  };
  const input = h('input', { type: 'text', placeholder: tr('직접 추가: 예) 나는 TypeScript를 선호한다') });
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    s.memories.unshift({ id: Date.now().toString(36), text: v.slice(0, 300), createdAt: Date.now() });
    input.value = '';
    save();
    draw();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) add(); });
  draw();
  return h('div', { class: 'form' },
    h('div', { class: 'setting-row' }, h('div', {}, h('b', {}, tr('메모리 사용')), h('small', { class: 'muted' }, tr('AI가 기억해 달라고 한 내용과 오래 유지되는 선호를 저장하고, 모든 채팅에서 참고합니다.'))),
      toggleSwitch(s.memoryEnabled, (v) => { s.memoryEnabled = v; save(); })),
    h('div', { class: 'share-row' }, input, h('button', { class: 'btn', onclick: add }, tr('추가'))),
    list,
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: async () => {
      if (!s.memories.length || !(await confirmDialog(tr('저장된 메모리를 모두 지울까요?'), { okLabel: tr('모두 삭제'), danger: true }))) return;
      s.memories = []; save(); draw();
    } }, tr('모두 지우기'))));
}

const TABS = [['general', tr('일반'), generalTab], ['account', tr('계정'), accountTab], ['features', tr('기능'), featuresTab], ['memory', tr('메모리'), memoryTab], ['keys', tr('API 키'), keysTab], ['usage', tr('사용량'), usageTab], ['advanced', tr('고급'), advancedTab], ['data', tr('데이터'), dataTab]];

export function openSettings(tab = 'general') {
  const nav = h('nav', { class: 'settings-nav' });
  const pane = h('div', { class: 'settings-pane' });
  const show = (id) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    pane.replaceChildren(TABS.find((t) => t[0] === id)[2]());
  };
  TABS.forEach(([id, label]) => nav.append(h('button', { 'data-tab': id, onclick: () => show(id) }, label)));
  modal(tr('설정'), h('div', { class: 'settings' }, nav, pane), { wide: true });
  show(tab);
}
