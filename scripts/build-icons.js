// Gera public/assets/icons.svg (sprite) a partir do lucide-static.
// Uso no front: <svg class="icon"><use href="/assets/icons.svg#i-calendar"/></svg>
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', 'lucide-static', 'icons');
const names = `home calendar calendar-days calendar-check calendar-x calendar-plus calendar-clock book-open book play play-circle
file-text file target pen-line pencil bot refresh-cw rotate-ccw x-circle x bar-chart-3 bar-chart line-chart pie-chart
notebook-pen star star-off user users user-plus user-check user-x search bell settings log-out log-in chevron-right chevron-left
chevron-down chevron-up chevrons-right chevrons-left check check-circle-2 check-check plus minus trash-2 edit-3 eye eye-off
clock timer flame trophy trending-up trending-down award brain graduation-cap layers list list-checks filter arrow-right arrow-left
arrow-up-right arrow-up-down external-link link video upload download image info alert-triangle alert-circle help-circle
message-square message-circle send shield shield-check lock unlock mail key credit-card dollar-sign activity percent hash
tag bookmark menu more-horizontal more-vertical grid-2x2 layout-dashboard folder folder-open library lightbulb zap rocket
compass map flag clipboard-list clipboard-check skip-forward pause square circle loader-2 sun moon globe phone briefcase
building-2 school atom flask-conical dna calculator sigma languages landmark scroll-text leaf history cpu database server
wifi wifi-off gauge save copy printer share-2 maximize-2 minimize-2 ban heart coffee sparkles wand-2 mic headphones
chart-no-axes-column languages palette dumbbell monitor scale gavel newspaper ruler shapes infinity function-square
inbox archive package sliders-horizontal toggle-left toggle-right badge-check circle-dot circle-help crosshair
arrow-down arrow-up move columns-3 rows-3 table-2 indent outdent align-left bold italic quote hourglass repeat
shuffle play-square film youtube captions git-branch route milestone party-popper thumbs-up thumbs-down smile frown meh
gift receipt wallet banknote coins landmark trending-up-down stethoscope microscope telescope orbit sun-medium cloud
scan-text file-up file-search fast-forward
`.split(/\s+/).filter(Boolean);
// nomes antigos → novos (o sprite expõe os dois ids)
const aliases = {
  'home': 'house', 'play-circle': 'circle-play', 'x-circle': 'circle-x', 'bar-chart-3': 'chart-column',
  'bar-chart': 'chart-bar', 'line-chart': 'chart-line', 'pie-chart': 'chart-pie', 'check-circle-2': 'circle-check-big',
  'check-circle': 'circle-check', 'edit-3': 'pen', 'edit': 'square-pen', 'alert-triangle': 'triangle-alert',
  'alert-circle': 'circle-alert', 'help-circle': 'circle-help', 'unlock': 'lock-open', 'more-horizontal': 'ellipsis',
  'more-vertical': 'ellipsis-vertical', 'loader-2': 'loader-circle', 'wand-2': 'wand-sparkles',
  'function-square': 'square-function', 'indent': 'indent-increase', 'outdent': 'indent-decrease',
  'play-square': 'square-play', 'trending-up-down': 'chart-no-axes-combined',
};
for (const target of Object.values(aliases)) names.push(target);
names.push('chart-area', 'chart-spline', 'list-tree', 'circle-check', 'square-pen');
const seen = new Set();
let symbols = '';
let missing = [];
for (const name of names) {
  if (seen.has(name)) continue;
  seen.add(name);
  const real = aliases[name] || name;
  const file = path.join(src, `${real}.svg`);
  if (!fs.existsSync(file)) { missing.push(name); continue; }
  const svg = fs.readFileSync(file, 'utf8');
  const inner = svg.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--.*?-->/gs, '').trim();
  symbols += `<symbol id="i-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>\n`;
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${symbols}</svg>\n`;
fs.mkdirSync(path.join(root, 'public', 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'assets', 'icons.svg'), sprite);
console.log(`icons: ${seen.size - missing.length} símbolos gerados`);
if (missing.length) console.log('não encontrados (ignorados):', missing.join(', '));
