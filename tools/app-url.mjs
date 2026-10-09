// Where the browser tests find the app: dist/index.html opened from disk (file://), or $APP_URL (e.g. a local
// server that mimics GitHub Pages: http://127.0.0.1:8766/hillberry-photoman/).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appUrl = () => process.env.APP_URL || 'file://' + path.join(root, 'dist', 'index.html');
