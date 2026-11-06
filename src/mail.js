// Outgoing email. Uses the first configured backend:
//   Resend  (RESEND_API_KEY + EMAIL_FROM, needs your own domain)
//   Brevo   (BREVO_API_KEY + EMAIL_FROM)
//   SMTP    (SMTP_USER + SMTP_PASS, defaults to Gmail smtp.gmail.com:465 with an app password)
const enc = new TextEncoder();

export function mailConfigured(env) {
  return Boolean((env.RESEND_API_KEY && env.EMAIL_FROM) || (env.BREVO_API_KEY && env.EMAIL_FROM) || (env.SMTP_USER && env.SMTP_PASS));
}

function parseFrom(env) {
  const raw = env.EMAIL_FROM || env.SMTP_USER || '';
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || env.APP_NAME || 'API-Ground', email: m[2].trim() } : { name: env.APP_NAME || 'API-Ground', email: raw.trim() };
}

export async function sendEmail(env, { to, subject, html, text }) {
  const from = parseFrom(env);
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: from.name + ' <' + from.email + '>', to: [to], subject, html, text }),
    });
    if (!res.ok) throw new Error('Resend: ' + (await res.text()).slice(0, 200));
    return;
  }
  if (env.BREVO_API_KEY && env.EMAIL_FROM) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    });
    if (!res.ok) throw new Error('Brevo: ' + (await res.text()).slice(0, 200));
    return;
  }
  if (env.SMTP_USER && env.SMTP_PASS) {
    await smtpSend(env, from, to, subject, html, text);
    return;
  }
  throw new Error('No email backend configured');
}

// ---------- minimal SMTP client over implicit TLS (port 465) ----------
function b64(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s) => s.replace(/.{1,76}/g, (l) => l + '\r\n');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=');

function buildMime(from, to, subject, html, text) {
  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  const domain = from.email.split('@')[1] || 'localhost';
  return [
    'From: ' + encWord(from.name) + ' <' + from.email + '>',
    'To: <' + to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomUUID() + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

async function smtpSend(env, from, to, subject, html, text) {
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(to)) throw new Error('Invalid recipient');
  const { connect } = await import('cloudflare:sockets');
  const socket = connect({ hostname: env.SMTP_HOST || 'smtp.gmail.com', port: Number(env.SMTP_PORT || 465) }, { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const read = async () => {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i].slice(0, 3)), text: lines.slice(0, i + 1).join(' | ') };
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP connection closed');
      buf += dec.decode(value, { stream: true });
    }
  };
  const cmd = async (line, ok) => {
    if (line != null) await writer.write(enc.encode(line + '\r\n'));
    const r = await read();
    if (!ok.includes(r.code)) throw new Error('SMTP ' + r.text.slice(0, 200));
    return r;
  };
  try {
    await cmd(null, [220]);
    await cmd('EHLO api-ground', [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(env.SMTP_USER), [334]);
    await cmd(b64(String(env.SMTP_PASS).replace(/\s+/g, '')), [235]);
    await cmd('MAIL FROM:<' + from.email + '>', [250]);
    await cmd('RCPT TO:<' + to + '>', [250, 251]);
    await cmd('DATA', [354]);
    // Dot-stuffing is unnecessary: base64 bodies and our headers never start a line with ".".
    await cmd(buildMime(from, to, subject, html, text) + '\r\n.', [250]);
    await cmd('QUIT', [221]).catch(() => {});
  } finally {
    try { socket.close(); } catch {}
  }
}

// ---------- templates ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const WELCOME = {
  ko: {
    subject: '{app}에 오신 것을 환영합니다',
    hello: '{name}님, 가입을 축하합니다!',
    intro: '{app} 계정이 만들어졌습니다. 이제 Claude, GPT, Gemini, Grok 등 여러 AI를 한곳에서 쓸 수 있어요.',
    tips: ['설정 → API 키에서 쓰고 싶은 AI의 키를 입력하세요. 키는 내 기기에만 저장됩니다.', 'NVIDIA NIM 무료 키로 수십 개 모델을 바로 써볼 수 있어요.', '로그인한 모든 기기에서 채팅과 프로젝트가 이어집니다.'],
    cta: '지금 시작하기',
    footer: '이 메일은 {email} 주소로 {app}에 가입해서 보내드렸습니다. 직접 가입하지 않았다면 이 메일을 무시하세요.',
  },
  en: {
    subject: 'Welcome to {app}',
    hello: 'Welcome aboard, {name}!',
    intro: 'Your {app} account is ready. Use Claude, GPT, Gemini, Grok and many more AI models in one place.',
    tips: ['Add a key for the AI you want in Settings → API keys. Keys stay on your device.', 'Try dozens of models right away with a free NVIDIA NIM key.', 'Your chats and projects follow you on every device you log in to.'],
    cta: 'Get started',
    footer: 'You received this email because {email} was used to sign up for {app}. If this wasn’t you, you can ignore it.',
  },
  ja: {
    subject: '{app}へようこそ',
    hello: '{name}さん、ご登録ありがとうございます！',
    intro: '{app}のアカウントが作成されました。Claude、GPT、Gemini、Grokなど、さまざまなAIを一か所で使えます。',
    tips: ['設定 → APIキーで使いたいAIのキーを入力してください。キーはデバイスにのみ保存されます。', 'NVIDIA NIMの無料キーで数十のモデルをすぐに試せます。', 'ログインしたすべてのデバイスでチャットとプロジェクトが続きます。'],
    cta: '今すぐ始める',
    footer: 'このメールは {email} で{app}に登録されたためお送りしました。お心当たりがない場合は無視してください。',
  },
};

export function pickLang(input) {
  const l = String(input || '').toLowerCase();
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ko')) return 'ko';
  return /\bko\b|ko-/.test(l) ? 'ko' : /\bja\b/.test(l) ? 'ja' : l ? 'en' : 'ko';
}

export function welcomeEmail({ app, origin, email, name, lang }) {
  const t = WELCOME[lang] || WELCOME.ko;
  const fill = (s) => s.replaceAll('{app}', app).replaceAll('{email}', email).replaceAll('{name}', name || email.split('@')[0]);
  const html = '<!doctype html><html><body style="margin:0;background:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Malgun Gothic\',sans-serif;color:#1a1f1b">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f4;padding:32px 12px"><tr><td align="center">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #dde3de">'
    + '<tr><td style="background:linear-gradient(135deg,#17a34a,#34c76b);padding:28px 32px;text-align:center">'
    + '<img src="' + esc(origin) + '/img/logo.png" width="56" height="56" alt="" style="border-radius:14px;background:#fff;display:inline-block">'
    + '<div style="color:#fff;font-size:22px;font-weight:700;margin-top:12px">' + esc(app) + '</div></td></tr>'
    + '<tr><td style="padding:32px">'
    + '<h1 style="font-size:22px;margin:0 0 12px">' + esc(fill(t.hello)) + '</h1>'
    + '<p style="font-size:15px;line-height:1.7;color:#39413b;margin:0 0 18px">' + esc(fill(t.intro)) + '</p>'
    + '<ul style="padding-left:20px;margin:0 0 24px;color:#39413b;font-size:14.5px;line-height:1.8">' + t.tips.map((x) => '<li>' + esc(fill(x)) + '</li>').join('') + '</ul>'
    + '<p style="text-align:center;margin:0 0 8px"><a href="' + esc(origin) + '/app" style="display:inline-block;background:#17a34a;color:#fff;text-decoration:none;padding:13px 28px;border-radius:12px;font-weight:600;font-size:15px">' + esc(t.cta) + '</a></p>'
    + '</td></tr><tr><td style="padding:18px 32px 26px;border-top:1px solid #eef1ee;color:#6b746d;font-size:12px;line-height:1.6">' + esc(fill(t.footer)) + '</td></tr>'
    + '</table></td></tr></table></body></html>';
  const text = [fill(t.hello), '', fill(t.intro), '', ...t.tips.map((x) => '- ' + fill(x)), '', t.cta + ': ' + origin + '/app', '', fill(t.footer)].join('\n');
  return { subject: fill(t.subject), html, text };
}

const CODE = {
  ko: { subject: '{app} 로그인 코드: {code}', body: '아래 코드를 입력해 로그인하세요. 10분 동안 유효합니다.', ignore: '요청하지 않았다면 이 메일을 무시하세요.' },
  en: { subject: '{app} login code: {code}', body: 'Enter this code to log in. It expires in 10 minutes.', ignore: 'If you didn’t request this, you can ignore this email.' },
  ja: { subject: '{app} ログインコード：{code}', body: '以下のコードを入力してログインしてください。10分間有効です。', ignore: 'お心当たりがない場合はこのメールを無視してください。' },
};

export function codeEmail({ app, code, lang }) {
  const t = CODE[lang] || CODE.ko;
  const subject = t.subject.replace('{app}', app).replace('{code}', code);
  const html = '<div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">' + esc(app) + '</h2>'
    + '<p>' + esc(t.body) + '</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:20px 0">' + esc(code) + '</p>'
    + '<p style="color:#6b746d;font-size:13px">' + esc(t.ignore) + '</p></div>';
  return { subject, html, text: t.body + '\n\n' + code + '\n\n' + t.ignore };
}
