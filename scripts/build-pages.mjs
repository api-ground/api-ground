// Copies public/ into pages/dist and adds a _worker.js that runs the same server code (advanced-mode Pages).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { obfuscateDir } from './obfuscate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'pages', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), dist, { recursive: true });
// Login-gated downloads (Android APK). Served only through /download/file tokens, never directly.
const downloads = path.join(root, 'downloads');
if (fs.existsSync(downloads)) fs.cpSync(downloads, path.join(dist, 'private-files'), { recursive: true });
fs.writeFileSync(path.join(dist, '_worker.js'), "import worker from '../../src/worker.js';\nexport default worker;\n");

// Optional: obfuscate the deployed client JS. Off by default (this is open source); set OBFUSCATE=1 to enable.
if (process.env.OBFUSCATE === '1') {
  const n = obfuscateDir(path.join(dist, 'js'), 'client');
  console.log('obfuscated client JS files:', n);
}
console.log('pages/dist ready');
