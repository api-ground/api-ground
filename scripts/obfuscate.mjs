// Obfuscates the JavaScript that ships to users (the web app's client JS, and the JS bundled inside the
// Windows installer). Runs only on build outputs / staging copies — never on the originals in the repo.
//
// ES-module safety: renameGlobals is OFF so exported/imported top-level names stay identical across files,
// which keeps the import graph (import { x } from './y.js') working after each file is obfuscated on its own.
import fs from 'node:fs';
import path from 'node:path';
import JavaScriptObfuscator from 'javascript-obfuscator';

// Heavy profile for the app's own logic (client JS). Strong but avoids transforms that break
// modern patterns: transformObjectKeys stays off (destructuring / spread / dynamic key access are everywhere).
function heavy(target) {
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.7,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayThreshold: 0.85,
    stringArrayEncoding: ['base64'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayIndexShift: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersType: 'function',
    stringArrayWrappersChainedCalls: true,
    transformObjectKeys: false,
    target,
  };
}

// Light profile: renames local identifiers and hides string literals, but keeps control flow intact.
// Used for big translation dictionaries (avoids huge bloat) and for server code with async generators / streams.
function light(target) {
  return {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    stringArray: true,
    stringArrayThreshold: 0.9,
    stringArrayEncoding: ['base64'],
    stringArrayRotate: true,
    stringArrayShuffle: true,
    transformObjectKeys: false,
    target,
  };
}

export function obfuscateCode(code, options) {
  return JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
}

// Walk a directory and obfuscate every .js/.mjs/.cjs file in place.
// kind: 'client' (browser, heavy) or 'server' (node, light). Locale dictionaries always use the light profile.
export function obfuscateDir(dir, kind = 'client') {
  let count = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue;
      const isLocale = p.replace(/\\/g, '/').includes('/locales/');
      const target = kind === 'server' ? 'node' : 'browser';
      const options = (kind === 'server' || isLocale) ? light(target) : heavy(target);
      const src = fs.readFileSync(p, 'utf8');
      fs.writeFileSync(p, obfuscateCode(src, options));
      count++;
    }
  };
  walk(dir);
  return count;
}
