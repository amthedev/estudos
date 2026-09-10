// Copia as bibliotecas de frontend do node_modules para public/vendor (sem dependência de CDN).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['chart.js/dist/chart.umd.js', 'chart.umd.js'],
  ['marked/marked.min.js', 'marked.min.js'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
];
for (const [src, dest] of files) {
  const from = path.join(root, 'node_modules', src);
  if (!fs.existsSync(from)) { console.error('não encontrado:', from); process.exitCode = 1; continue; }
  fs.copyFileSync(from, path.join(out, dest));
  console.log('vendor:', dest);
}
