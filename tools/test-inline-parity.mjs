// node --test tools/test-inline-parity.mjs
//
// tools/sky-panorama.js is also pasted into index.html by hand, between the
// "// --- sky:start" and "// --- sky:end" markers, alongside tools/sky-astro.js
// and tools/stars.js. nothing runs the paste, so nothing else notices the two
// copies drifting apart; this is that check, for the one file most likely to
// change under active work. line endings are normalised (index.html is CRLF,
// tools/sky-panorama.js may or may not be) since a copy that only differs by
// \r is not a real drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = s => s.replace(/\r\n/g, '\n').trimEnd();

test('the sky-panorama.js pasted into index.html matches tools/sky-panorama.js', () => {
  const src = readFileSync(join(ROOT, 'tools', 'sky-panorama.js'), 'utf8');
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const lines = page.split(/\r?\n/);
  const startIdx = lines.findIndex(l => l.includes('---------- sky-panorama.js ----------'));
  const endIdx = lines.findIndex(l => l.includes('--- sky:end ---'));
  assert.ok(startIdx >= 0, 'the "---------- sky-panorama.js ----------" header is still in index.html');
  assert.ok(endIdx > startIdx, 'the "--- sky:end ---" marker is still after it');
  const inlined = lines.slice(startIdx + 1, endIdx).join('\n');
  assert.equal(norm(inlined), norm(src),
    'index.html\'s inlined copy has drifted from tools/sky-panorama.js -- edit the source file, then paste the same change into index.html between the markers');
});
