// Refresh the standalone preview with the exact renderer used by the site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const previewPath = path.join(root, 'moon-preview.html');
const preview = fs.readFileSync(previewPath, 'utf8');
const start = site.indexOf('function moonPath(');
const end = site.indexOf('// the tab icon shows', start);
const marker = '// Snapshot of the site\'s moon renderer; this preview works entirely offline.';
const previewStart = preview.indexOf(marker);
const previewEnd = preview.indexOf('const phases = [', previewStart);
if (start < 0 || end <= start || previewStart < 0 || previewEnd <= previewStart) {
  throw new Error('Moon renderer or preview markers missing');
}
const texture = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(root, 'assets/moon-full.jpg')).toString('base64');
const renderer = site.slice(start, end).trim().replace("'assets/moon-full.jpg'", JSON.stringify(texture));
fs.writeFileSync(previewPath, preview.slice(0, previewStart) + marker + '\n' + renderer + '\n\n' + preview.slice(previewEnd));
console.log('moon-preview.html refreshed with the current renderer and embedded lunar image.');
