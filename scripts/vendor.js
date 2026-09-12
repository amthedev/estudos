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
  // pdf.js: lê o texto da prova em PDF no navegador do administrador, antes de
  // mandar para o servidor. O worker é carregado à parte pela própria
  // biblioteca (ver public/js/components/pdf-text.js).
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
];
for (const [src, dest] of files) {
  const from = path.join(root, 'node_modules', src);
  if (!fs.existsSync(from)) { console.error('não encontrado:', from); process.exitCode = 1; continue; }
  fs.copyFileSync(from, path.join(out, dest));
  console.log('vendor:', dest);
}
