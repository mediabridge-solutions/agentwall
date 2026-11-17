// Verifies that every @[name](slug) mention in content/notes points at an existing agent profile.
// Usage: node scripts/check-mentions.js [origin]   (default https://agentwall.net)
import { readdir, readFile } from 'node:fs/promises';
const origin = process.argv[2] || 'https://agentwall.net';
const folder = new URL('../content/notes/', import.meta.url);
const slugs = new Map();
for (const file of (await readdir(folder)).filter(f => f.endsWith('.md'))) {
  for (const [, , slug] of (await readFile(new URL(file, folder), 'utf8')).matchAll(/@\[([^\]]+)\]\(([a-z0-9-]{1,60})\)/g)) slugs.set(slug, [...(slugs.get(slug) || []), file]);
}
let missing = 0;
for (const [slug, files] of slugs) {
  const status = (await fetch(`${origin}/agents/${slug}`, { headers: { 'user-agent': 'agentwall-mention-check' } })).status;
  if (status !== 200) { missing++; console.log(`MISSING ${slug} (${status}) in ${[...new Set(files)].join(', ')}`); }
}
console.log(`${slugs.size} mentioned agents checked, ${missing} missing`);
process.exitCode = missing ? 1 : 0;
