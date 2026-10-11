// Extract only the supplied homepage; do not import application or other routes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const archive = process.argv[2];
if (!archive) throw new Error('Pass the design archive path');
const destination = resolve(import.meta.dirname, 'halo-homepage');
const read = (name: string) => execFileSync('unzip', ['-p', archive, `templates/halo-website/${name}`], { encoding: 'utf8' });
const body = (source: string) => source.match(/<x-dc>([\s\S]*?)<\/x-dc>/)?.[1] ?? '';
let nav = body(read('Nav.dc.html'));
nav = nav.replace(/<sc-if value="\{\{ on\.[^]*?<\/sc-if>/g, '');
nav = nav.replace(/<\/?sc-if\b[^>]*>/g, '');
let content = body(read('HaloWebsite.dc.html'));
const head = content.match(/<helmet>([\s\S]*?)<\/helmet>/)?.[1] ?? '';
content = content.replace(/<helmet>[\s\S]*?<\/helmet>/, '');
content = content.replace(/<dc-import name="Nav"[^>]*><\/dc-import>/, nav)
  .replace(/<dc-import name="Footer"[^>]*><\/dc-import>/, body(read('Footer.dc.html')));
const links: Record<string, string> = { 'HaloWebsite.dc.html': '#top', 'Agents.dc.html': '#agents', 'Guard.dc.html': '#guard', 'Routines.dc.html': '#routines', 'About.dc.html': '#about', 'Download.dc.html': '#download' };
for (const [from, to] of Object.entries(links)) content = content.replaceAll(`href="${from}"`, `href="${to}"`);
// Assign section anchors without changing the supplied markup's presentation.
for (const [word, id] of [['Agents', 'agents'], ['Guard', 'guard'], ['Routines', 'routines']] as const) {
  const sections = [...content.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)];
  const match = sections.find(m => new RegExp(word, 'i').test(m[0]) && !/min-width:980px/.test(m[0]));
  if (match && !new RegExp(`id="${id}"`).test(content)) content = content.replace(match[0], match[0].replace('<section', `<section id="${id}"`));
}
content = content.replace('<footer ', '<footer id="about" ');
const cleanHead = head.replace(/<script src="\.\/ds-base.js"><\/script>/, '');
const html = `<!doctype html><html lang="en" id="top"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Halo — AI-native Chromium browser</title>${cleanHead}</head><body>${content}<script>
const observer = new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); } }), {threshold: .12});
document.querySelectorAll('[data-r]').forEach(element => observer.observe(element));
</script></body></html>`;
if (/<dc-import|<sc-if|\{\{/.test(html)) throw new Error('Unresolved design template');
for (const target of html.matchAll(/href="#([^\"]+)"/g)) if (!html.includes(`id="${target[1]}"`)) throw new Error(`Missing anchor: ${target[1]}`);
mkdirSync(destination, { recursive: true });
writeFileSync(resolve(destination, 'index.html'), html);
console.log(destination);
