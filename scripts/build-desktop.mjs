// Builds the Windows installer with the bundled JS obfuscated.
// The originals in public/js and src are backed up, obfuscated IN PLACE, packaged, then restored — so the
// working tree is left unchanged. A finally block and a start-of-run recovery guard protect against a crash
// leaving obfuscated code behind. Set OBFUSCATE=0 to build without obfuscation (for debugging).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { obfuscateDir } from './obfuscate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backupRoot = path.join(root, '.obf-backup');
// [directory to obfuscate, obfuscation kind]
const targets = [['public/js', 'client'], ['src', 'server']];
const backupName = (rel) => rel.replace(/[\\/]/g, '__');

// electron-builder reserves a folder named "app" as the application directory. Our distribution copy lives in
// app/, which collides, so stash it aside during the build and put it back afterwards.
const appDir = path.join(root, 'app');
const appStash = path.join(root, '.app-stash');
function stashAppDir() { if (fs.existsSync(appDir) && !fs.existsSync(appStash)) fs.renameSync(appDir, appStash); }
function unstashAppDir() { if (fs.existsSync(appStash)) { fs.rmSync(appDir, { recursive: true, force: true }); fs.renameSync(appStash, appDir); } }
if (fs.existsSync(appStash) && !fs.existsSync(appDir)) unstashAppDir(); // recover from an interrupted build

function restoreAll() {
  if (!fs.existsSync(backupRoot)) return;
  for (const [rel] of targets) {
    const saved = path.join(backupRoot, backupName(rel));
    const live = path.join(root, rel);
    if (fs.existsSync(saved)) {
      fs.rmSync(live, { recursive: true, force: true });
      fs.cpSync(saved, live, { recursive: true });
    }
  }
  fs.rmSync(backupRoot, { recursive: true, force: true });
}

// Recover from a previous interrupted build before doing anything else.
if (fs.existsSync(backupRoot)) {
  console.warn('found leftover .obf-backup from an interrupted build — restoring originals first');
  restoreAll();
}

// Off by default (open source); set OBFUSCATE=1 to obfuscate the bundled JS.
const obfuscate = process.env.OBFUSCATE === '1';
try {
  stashAppDir();
  if (obfuscate) {
    fs.mkdirSync(backupRoot, { recursive: true });
    for (const [rel, kind] of targets) {
      fs.cpSync(path.join(root, rel), path.join(backupRoot, backupName(rel)), { recursive: true });
      const n = obfuscateDir(path.join(root, rel), kind);
      console.log(`obfuscated ${rel} (${kind}): ${n} files`);
    }
  }
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  if (!env.TEMP || !env.TEMP.startsWith(root)) { env.TEMP = path.join(root, '.tmp'); env.TMP = env.TEMP; }
  fs.mkdirSync(env.TEMP, { recursive: true });
  console.log('running electron-builder…');
  execSync('npx electron-builder --win --x64', { cwd: root, env, stdio: 'inherit' });
} finally {
  restoreAll();
  unstashAppDir();
  if (obfuscate) console.log('restored original source files');
}
