/**
 * Bundle the /trading app into the single-page form a Claude artifact needs:
 * CSS and JS inlined into one fragment (the artifact CSP only allows scripts
 * and styles from a short CDN list), data/*.json published beside it.
 *
 * Output: dist/artifact/index.html  and  dist/artifact/data/*.json
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';

const OUT = 'dist/artifact';
rmSync('dist', { recursive: true, force: true });
mkdirSync(`${OUT}/data`, { recursive: true });

const js = (await build({
  entryPoints: ['trading/js/app.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  write: false,
})).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = readFileSync('trading/css/app.css', 'utf8');
const html = readFileSync('trading/index.html', 'utf8');
const fonts = html.match(/<link href="(https:\/\/fonts\.googleapis\.com[^"]+)"/)[1];
// the artifact title is a plain name, without the page's " — IBKR" suffix
const title = html.match(/<title>([^<]+)<\/title>/)[1].replace(/\s+[—–-]\s+.*$/, '');
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'))
  .replace('<a class="brand" href="../">', '<span class="brand">')
  .replace('Jianlong&nbsp;Lek</a>', 'Jianlong&nbsp;Lek</span>')
  .trim();

writeFileSync(`${OUT}/index.html`, `<title>${title}</title>
<link rel="stylesheet" href="${fonts}">
<style>
${css}
</style>
${body}
<script>
${js}
</script>
`);

for (const f of readdirSync('trading/data')) cpSync(`trading/data/${f}`, `${OUT}/data/${f}`);
console.log(`artifact page ${(readFileSync(`${OUT}/index.html`).length / 1024).toFixed(0)} KB, ${readdirSync(`${OUT}/data`).length} data files`);
