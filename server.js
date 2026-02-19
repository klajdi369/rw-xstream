import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3004;
const HOST = '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

function serveStatic(reqPath, res) {
  const rel = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(DIST_DIR, path.normalize(rel));

  if (!filePath.startsWith(DIST_DIR)) {
    send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (!err) {
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, MIME_TYPES[ext] || 'application/octet-stream', data);
      return;
    }

    fs.readFile(path.join(DIST_DIR, 'index.html'), (indexErr, indexData) => {
      if (indexErr) {
        send(res, 500, 'text/plain; charset=utf-8', 'Build not found. Run: npm run build');
        return;
      }
      send(res, 200, 'text/html; charset=utf-8', indexData);
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  serveStatic(url.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`IPTV app server listening on http://${HOST}:${PORT}`);
});
