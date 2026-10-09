// Builds the site:   node build.mjs      ->   dist/
//
//   dist/index.html                the app. This is what GitHub Pages serves at the site root.
//   dist/Hillberry-PhotoMan.html   the very same file under its shareable name (the "offline copy").
//   dist/.nojekyll                 tells Pages not to run Jekyll over it.
//
// The app itself is ONE self-contained file: HTML, CSS, JavaScript and the logo are all inlined, so it works
// offline from any location (a USB stick, an email attachment, a folder on the desktop).
//
// Optional environment:
//   SITE_URL   e.g. https://saccade-studio.github.io/hillberry-photoman   (adds a canonical link, and lets offline copies point to the latest version)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const parts = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js')).sort().map((f) => read(path.join(dir, f)));
const esc = (s) => s.replace(/<\/script/gi, '<\\/script');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const git = (args) => { try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return ''; } };

const pkg = JSON.parse(read('package.json'));
const site = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const build = {
  version: pkg.version,
  date: git(['show', '-s', '--format=%cs', 'HEAD']) || new Date().toISOString().slice(0, 10),
  sha: (process.env.GITHUB_SHA || '').slice(0, 7) || git(['rev-parse', '--short=7', 'HEAD']),
  site,
};

const DESCRIPTION = 'Add the Hillberry watermark, crop to Scott Print Sizes (8×10, 13×19) or social formats, and export at full resolution with the original color profile. Runs entirely in your browser, offline.';
const head = [`<meta name="description" content="${attr(DESCRIPTION)}">`];
if (site) head.push(`<link rel="canonical" href="${attr(site)}/">`);

const core = parts('src/core').join('\n');
const logo = fs.readFileSync(path.join(root, 'assets', 'hillberry-logo.webp')).toString('base64');
const app = `(function () {\n'use strict';\nconst HILLBERRY_WEBP_B64 = "${logo}";\nconst BUILD = ${JSON.stringify(build)};\n${parts('src/app').join('\n')}\n})();`;

const html = read('src/index.template.html')
  .replace('<!--{{HEAD}}-->', () => head.join('\n'))
  .replace('/*{{CSS}}*/', () => read('src/styles.css'))
  .replace('/*{{CORE}}*/', () => esc(core))
  .replace('/*{{APP}}*/', () => esc(app));
if (/\{\{[A-Z]+\}\}/.test(html)) throw new Error('unreplaced template placeholder in the output');

const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), html);
fs.writeFileSync(path.join(dist, 'Hillberry-PhotoMan.html'), html);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

console.log(`Built dist/  index.html + Hillberry-PhotoMan.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB each  ` +
  `(core ${(core.length / 1024).toFixed(0)} KB, app ${(app.length / 1024).toFixed(0)} KB, logo ${(logo.length / 1024).toFixed(0)} KB base64)  ` +
  `v${build.version} ${build.date}${build.sha ? ' ' + build.sha : ''}${site ? '  site ' + site : ''}`);
