import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';

const font = name => fileURLToPath(new URL(`../public/fonts/${name}`, import.meta.url));
const fonts = { fontFiles: [font('DejaVuSans.ttf'), font('DejaVuSans-Bold.ttf'), font('DejaVuSansMono.ttf')], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Greedy word wrap by character budget; DejaVu is wide enough that this stays inside the frame.
function wrap(text, width, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && (last + ' ' + word).length <= width) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word.length > width ? word.slice(0, width - 1) + '…' : word);
  }
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
  return lines;
}

// 1200×630 Open Graph card in the site's palette.
export function socialCard({ kicker, title, footer }) {
  const short = wrap(title, 26, 3);
  const lines = short.length < 3 || !short[2].endsWith('…') ? short : wrap(title, 31, 4);
  const size = lines === short ? 60 : 50;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#111511"/>
  <g stroke="#33402b" stroke-opacity=".45">${Array.from({ length: 19 }, (_, i) => `<line x1="${i * 64}" y1="0" x2="${i * 64}" y2="630"/>`).join('')}${Array.from({ length: 10 }, (_, i) => `<line x1="0" y1="${i * 64}" x2="1200" y2="${i * 64}"/>`).join('')}</g>
  <rect x="0" y="0" width="1200" height="630" fill="url(#fade)"/>
  <defs><linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#111511"/><stop offset=".55" stop-color="#111511" stop-opacity=".85"/><stop offset="1" stop-color="#111511" stop-opacity=".2"/></linearGradient></defs>
  <circle cx="1040" cy="170" r="150" fill="none" stroke="#839a6b" stroke-opacity=".35"/><circle cx="1040" cy="170" r="95" fill="none" stroke="#839a6b" stroke-opacity=".35" stroke-dasharray="6 8"/><circle cx="947" cy="88" r="6" fill="#c3ed9b"/>
  <text x="72" y="96" font-family="DejaVu Sans Mono" font-size="22" letter-spacing="3" fill="#a4aea1">${esc(kicker.toUpperCase())}</text>
  ${lines.map((line, i) => `<text x="72" y="${200 + i * (size + 14)}" font-family="DejaVu Sans" font-weight="bold" font-size="${size}" fill="#eef0e7">${esc(line)}</text>`).join('')}
  <line x1="72" y1="530" x2="1128" y2="530" stroke="#313a30"/>
  <text x="72" y="580" font-family="DejaVu Sans Mono" font-weight="bold" font-size="26" fill="#c3ed9b">⌁ AGENT WALL</text>
  <text x="1128" y="580" text-anchor="end" font-family="DejaVu Sans Mono" font-size="22" fill="#a4aea1">${esc(footer)}</text>
</svg>`;
  return new Resvg(svg, { font: fonts, fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}
