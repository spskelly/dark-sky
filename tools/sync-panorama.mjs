// pastes tools/sky-panorama.js into index.html between the
// "---------- sky-panorama.js ----------" header line and "// --- sky:end ---",
// which is what tools/test-inline-parity.mjs checks was done. line endings
// follow the page (crlf), never the source file.
//
//   node tools/sync-panorama.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'tools', 'sky-panorama.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
const eol = page.includes('\r\n') ? '\r\n' : '\n';
const lines = page.split(/\r?\n/);
const a = lines.findIndex(l => l.includes('---------- sky-panorama.js ----------'));
const b = lines.findIndex(l => l.includes('--- sky:end ---'));
if (a < 0 || b <= a) { console.error('markers missing from index.html'); process.exit(1); }
const out = lines.slice(0, a + 1).concat(src.split('\n'), lines.slice(b)).join(eol);
if (out === page) { console.log('unchanged'); process.exit(0); }
writeFileSync(join(ROOT, 'index.html'), out);
console.log(`index.html updated, ${b - a - 1} lines replaced by ${src.split('\n').length}`);
