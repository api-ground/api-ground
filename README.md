# API-Ground

Claude, GPT, Gemini, Grok, Kimi, GLM, DeepSeek, NVIDIA 무료 모델 등 20개 이상의 AI API를 한곳에서 쓰는 워크스페이스입니다. 웹사이트(Cloudflare Pages), Windows 데스크톱 앱, Android 앱으로 제공됩니다.

- `/` 공식 홈페이지 · `/app` 앱 · `/share/<id>` 공유된 대화 · `/download` 데스크톱 앱 다운로드

## 기능

**채팅**
- 공급자 20개: Claude(Anthropic 공식 SDK), OpenAI, Gemini, Grok, DeepSeek, Kimi, GLM, Qwen, Mistral, MiniMax, NVIDIA NIM(무료 체험), Groq, OpenRouter, Together, Fireworks, Cerebras, SambaNova, Hugging Face, Cohere, Perplexity
- 모델 선택기에 공급자·모델별 브랜드 아이콘 표시, 키를 넣으면 최신 모델 목록을 자동으로 불러옴 (NVIDIA·OpenRouter는 키 없이도 목록 표시)
- 메시지 편집·다시 생성 시 브랜치, 응답 스타일, 확장 사고, 웹 검색(Gemini·Claude), 첨부 파일, 음성 입력, LaTeX, 제목 자동 생성
- **메모리**: "기억해줘"라고 한 내용과 오래 가는 선호를 저장해 모든 채팅에서 참고 (설정 → 메모리에서 관리)
- **공유 링크**: 대화를 읽기 전용 링크로 공유 (로그인 필요)

**아티팩트 · 프로젝트 · Code**
- 아티팩트: HTML, React, SVG, Mermaid, 문서, 코드를 옆 패널에 생성·실행, 버전 비교
- 프로젝트: 지침과 자료 파일을 프로젝트 안 모든 채팅에 적용
- Code: 파일을 읽고 고치는 코딩 에이전트. 데스크톱 앱에서는 내 PC 폴더와 PowerShell 명령까지 사용

**계정 · 동기화**
- 이메일(비밀번호 · 인증 코드), Google 로그인
- 가입하면 가입한 이메일 주소로 환영 메일 발송
- 채팅·프로젝트·설정을 기기 간 동기화 (API 키, 이미지·PDF 첨부, Code 세션은 동기화하지 않음)
- 로그인하지 않아도 모든 기능 사용 가능

**기타**
- 화면 테마(시스템/밝은/어두운), 언어(시스템/한국어/English/日本語), 키보드 단축키(Ctrl+/)

## 구조
```
public/                    화면 (웹사이트 · 데스크톱 앱 · 모바일 앱이 모두 같은 화면을 씀)
  index.html               공식 홈페이지
  app.html                 앱 화면
  privacy.html, terms.html 개인정보 처리방침, 이용약관
  manifest.webmanifest     홈 화면 앱 설정
  css/                     app.css(앱), site.css(홈페이지), share.css(공유 페이지)
  js/main.js               앱 시작 · 화면 이동 · 사이드바
  js/chat.js               채팅 · 모델 선택 · 메모리 · 한도 걸리면 다른 AI로 이어가기
  js/code.js               Code 모드(코딩 에이전트) · AI 교체 시 작업 기록 변환
  js/usage.js              사용 한도 아이콘 · 팝업 · 설정의 사용량 화면
  js/account.js            로그인 · 동기화 · 공유 링크
  js/settings.js           설정 화면
  js/artifacts.js          아티팩트 패널
  js/projects.js, pages.js 프로젝트, 채팅 목록 등 페이지
  js/api.js                서버 호출 · 브랜드 아이콘
  js/state.js              저장소(IndexedDB) · 기본 설정
  js/site.js               홈페이지 동작 (로그인, 다운로드)
  js/i18n.js, locales/     언어 (en, ja — 한국어 원문이 키)
  img/                     로고, 아이콘, AI 브랜드 아이콘(img/brands, LobeHub Icons, MIT)
src/                       서버 (Cloudflare)
  worker.js                주소별 처리 · 채팅/에이전트 중계
  providers.js             AI 공급자 20개 목록 (주소, 기본 모델, 키 발급 링크)
  anthropic.js             Claude (공식 @anthropic-ai/sdk)
  limits.js                공급자 사용 한도 읽기 · 한도 초과 오류 구분
  auth.js                  로그인 · 세션 · 동기화 · 공유 · 다운로드 (Cloudflare D1)
  mail.js                  환영 메일 · 인증 코드 메일 (Gmail SMTP 등)
electron/                  Windows 데스크톱 앱 (main.js, preload.cjs)
mobile/                    Android 앱 (Capacitor): capacitor.config.json, android/ 프로젝트
scripts/build-pages.mjs    배포용 pages/dist 만들기 (난독화는 선택: OBFUSCATE=1)
scripts/build-desktop.mjs  exe 빌드 (난독화는 선택: OBFUSCATE=1)
scripts/obfuscate.mjs      난독화 설정 (javascript-obfuscator, 기본 꺼짐)
pages/wrangler.toml        Cloudflare Pages 설정 (api-ground)
wrangler.toml              로컬 개발용 Workers 설정
build/icon.png             앱 아이콘 원본
package.json               명령어(npm run ...) · 데스크톱 빌드 설정
```

## 웹사이트 배포 (Cloudflare Pages)

공식 사이트: **https://api-ground.pages.dev** (Pages 프로젝트 `api-ground`, 설정은 `pages/wrangler.toml`)

수정한 내용을 다시 배포하려면:
```bash
npm run deploy:pages
```
`public/`을 `pages/dist`로 복사하고, 같은 서버 코드(`src/worker.js`)를 `_worker.js`로 붙여 배포합니다. 데이터베이스는 D1 `api-playground`를 그대로 씁니다.

> **난독화(선택)**: 기본은 꺼져 있습니다. `OBFUSCATE=1`을 붙여 실행하면 배포되는 화면 코드(`public/js`)만 난독화합니다(원본 `public/`은 그대로, `pages/dist` 사본만 처리). 오픈소스로 공개하는 경우 보통 꺼 둡니다.

### 로그인 · 메일 설정 (필요한 것만)
- **메일 보내기** (환영 메일, 이메일 인증 코드): Gmail 앱 비밀번호로 `SMTP_USER`, `SMTP_PASS` 등록. 또는 `RESEND_API_KEY`/`BREVO_API_KEY` + `EMAIL_FROM`. 로컬(`localhost`)에서는 설정 없이 코드가 화면에 표시됩니다.
- **Google**: Google Cloud Console → OAuth 클라이언트(웹) 생성, 승인된 리디렉션 URI에 `https://<도메인>/api/auth/google/callback` 추가 → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

비밀값은 Pages 프로젝트에 등록합니다:
```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name api-ground
```
(나머지 값도 같은 방식으로 등록)

### 선택 설정
- 서버 API 키: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `NVIDIA_API_KEY` 등 (`src/providers.js`의 `envKey`)
- 서버 키를 등록했다면 **`ACCESS_PASSWORD`를 꼭 설정**하세요. 없으면 주소를 아는 누구나 내 키로 요금을 쓸 수 있습니다.
- `DOWNLOAD_URL`: 홈페이지 "다운로드" 버튼이 연결될 설치 파일 주소 (예: GitHub Releases). 설치 파일은 Workers 파일 크기 제한(25MB)보다 커서 사이트에 직접 올릴 수 없습니다.

## 데스크톱 앱 (Windows)

```bash
npm run desktop
```
설치 파일 만들기 (결과: `release/API-Ground-Setup-버전.exe`):
```bash
npm run dist
```
`npm run dist`는 기본적으로 난독화 없이 패키징합니다. `OBFUSCATE=1 npm run dist`로 실행하면 exe 안의 JS를 난독화한 뒤 포장하고, 원본은 빌드가 끝나면 자동으로 복원됩니다.
- 데스크톱 앱에서 로그인·동기화·공유를 쓰려면 설정 → 계정에 배포한 웹사이트 주소를 입력합니다. Google 로그인은 브라우저에서 진행된 뒤 `apiground://` 링크로 앱에 돌아옵니다.
- 이전 이름(AI Playground)으로 쓰던 데이터는 첫 실행 때 자동으로 옮겨집니다.
- 코드 서명이 없어 처음 실행 시 SmartScreen 경고가 뜰 수 있습니다. "추가 정보 → 실행"을 누르세요.

## 모바일 앱 (`mobile/`, Capacitor)

앱은 https://api-ground.pages.dev/app 을 불러오는 껍데기라서, 사이트를 배포하면 앱 내용도 바로 바뀝니다. Google 로그인은 시스템 브라우저에서 진행된 뒤 `apiground://` 링크로 앱에 돌아옵니다.

**Android APK** (JDK 21과 Android SDK 36 필요, `ANDROID_HOME` 설정 또는 `mobile/android/local.properties`에 `sdk.dir` 지정):
```bash
cd mobile/android
./gradlew assembleRelease
```
결과 `mobile/android/app/build/outputs/apk/release/app-release.apk`를 `downloads/API-Ground.apk`로 복사하고 사이트를 배포하면, 홈페이지에서 로그인한 사용자만 받을 수 있습니다. 서명 키(`mobile/android/api-ground-release.jks`, `keystore.properties`)는 깃에서 제외되어 있습니다. **잃어버리면 앱 업데이트를 같은 앱으로 설치할 수 없으니 따로 백업하세요.**

앱 스토어에는 올리지 않고, Android 앱은 홈페이지에서만 배포합니다.

## 로컬 실행
```bash
npm run dev
```
로컬 D1 데이터베이스가 자동으로 만들어져 이메일 로그인까지 시험할 수 있습니다.

## 새 공급자 추가
OpenAI 호환 API는 `src/providers.js`에 한 줄을 추가하고, 아이콘 SVG를 `public/img/brands/`에 넣으면 됩니다.
