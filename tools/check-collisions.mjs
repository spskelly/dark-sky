// every top-level declaration in index.html shares one scope. a duplicate const
// there is a SyntaxError that stops the whole script, calendar included, not
// just the feature that introduced it, and nothing in the page will tell you:
// it simply goes blank.
//
// this sweeps the page's own inline scripts plus any files staged to be inlined
// into it, and reports every name claimed twice.
//
//   node tools/check-collisions.mjs
//   node tools/check-collisions.mjs tools/sky-astro.js tools/stars.js
import fs from 'node:fs';

const DECL = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;

function topLevel(text) {
  const m = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    const d = line.match(DECL);
    if (d) m.set(d[1], (m.get(d[1]) || []).concat(i + 1));
  });
  return m;
}

function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out.join('\n');
}

const html = fs.readFileSync('index.html', 'utf8');
const sources = { 'index.html': topLevel(inlineScripts(html)) };
for (const f of process.argv.slice(2)) sources[f] = topLevel(fs.readFileSync(f, 'utf8'));

const owner = new Map();
const clashes = [];
for (const [file, names] of Object.entries(sources)) {
  for (const [name, lines] of names) {
    const prev = owner.get(name);
    if (prev) clashes.push({ name, a: prev, b: { file, lines } });
    else owner.set(name, { file, lines });
  }
}

for (const [f, m] of Object.entries(sources)) {
  console.log(String(m.size).padStart(4), 'top-level declarations in', f);
}
console.log();
if (!clashes.length) {
  console.log(`no collisions across ${owner.size} identifiers`);
} else {
  console.log(`COLLISIONS (${clashes.length}), each one stops the whole script:`);
  for (const c of clashes) {
    console.log(`  ${c.name.padEnd(20)} ${c.a.file}:${c.a.lines.join(',')}  VS  ${c.b.file}:${c.b.lines.join(',')}`);
  }
  process.exitCode = 1;
}
