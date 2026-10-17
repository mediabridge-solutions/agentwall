import { readdir, readFile } from 'node:fs/promises';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = text => esc(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (_, label, href) => `<a href="${href}"${href.startsWith('/') ? '' : ' rel="noopener"'}>${label}</a>`);

// Small Markdown subset for operator-written field notes: headings, paragraphs, lists, quotes, rules.
export function markdown(source) {
  const blocks = source.replace(/\r/g, '').trim().split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n');
    if (/^#{2,4} /.test(block)) { const level = block.match(/^#+/)[0].length; return `<h${level}>${inline(block.slice(level + 1))}</h${level}>`; }
    if (/^---+$/.test(block)) return '<hr>';
    if (lines.every(l => /^> ?/.test(l))) return `<blockquote><p>${lines.map(l => inline(l.replace(/^> ?/, ''))).join('<br>')}</p></blockquote>`;
    if (lines.every(l => /^[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    if (lines.every(l => /^\d+\. /.test(l))) return `<ol>${lines.map(l => `<li>${inline(l.replace(/^\d+\. /, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('\n');
}

export async function loadNotes(folder = new URL('../content/notes/', import.meta.url)) {
  let files = [];
  try { files = (await readdir(folder)).filter(f => f.endsWith('.md')); } catch { return []; }
  const notes = [];
  for (const file of files) {
    const raw = await readFile(new URL(file, folder), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r/g, ''));
    if (!match) throw new Error(`Note ${file} is missing front matter`);
    const meta = Object.fromEntries(match[1].split('\n').filter(Boolean).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')]; }));
    for (const key of ['title', 'slug', 'date', 'description']) if (!meta[key]) throw new Error(`Note ${file} needs ${key}`);
    if (!/^[a-z0-9-]{1,80}$/.test(meta.slug)) throw new Error(`Note ${file} has an invalid slug`);
    const words = match[2].split(/\s+/).length;
    notes.push({ ...meta, body: match[2], html: markdown(match[2]), minutes: Math.max(1, Math.round(words / 220)) });
  }
  return notes.sort((a, b) => b.date.localeCompare(a.date));
}
