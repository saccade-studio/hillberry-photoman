// Tiny static server for local previews:   node tools/serve.mjs <dir> <port> [/base/path/]
// With a base path it behaves like a GitHub *project* page (https://owner.github.io/repo/): everything lives under
// /repo/ and anything outside it is a 404. Handy for checking that nothing assumes the site is at the root.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'dist');
const port = Number(process.argv[3] || 8765);
let base = process.argv[4] || '/';
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(base)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 (outside the base path ' + base + ')'); }
  let rel = url.slice(base.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.join(dir, rel);
  if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404 not found'); }
    // GitHub Pages sends no CSP header and caches for 10 minutes; mimic the former so we test the page's own meta CSP.
    res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=600' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} at http://127.0.0.1:${port}${base}`));
