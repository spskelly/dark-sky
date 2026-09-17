// spawned by test-panorama.mjs with TZ=Asia/Tokyo to prove the eastern-date
// helpers in sky-panorama.js do not depend on the process's own timezone --
// Intl.DateTimeFormat is given an explicit timeZone every time, never the
// runtime default, so a browser set to Tokyo has to land on the same
// instants and the same eastern civil date a browser set to Eastern does.
// prints one line of JSON to stdout; nothing here is a test by itself.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sky-panorama.js'), 'utf8');
const ctx = { Math, HORIZON_ALT_MIN: -10, HORIZON_ALT_RANGE: 90 };
vm.createContext(ctx);
vm.runInContext(src, ctx);

const dates = [[2026, 1, 15], [2026, 7, 15], [2026, 3, 8], [2026, 11, 1]];
const out = dates.map(([y, mo, d]) => {
  const t = ctx.easternInstant(y, mo, d, 17);
  return { iso: t.toISOString(), parts: ctx.easternParts(t) };
});
process.stdout.write(JSON.stringify(out));
