const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIMES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
};

const server = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  url = url.split('?')[0];
  const filePath = path.join(ROOT, url);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server Error');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIMES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(data);
  });
});

let currentPort = Number(PORT) || 3000;
let announced = false;

function tryListen() {
  server.listen(currentPort);
}

server.on('listening', () => {
  if (announced) return;
  announced = true;
  console.log('Sonic: http://localhost:' + currentPort);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    currentPort += 1;
    announced = false;
    console.log('Port in use, trying http://localhost:' + currentPort + ' ...');
    setTimeout(tryListen, 10);
    return;
  }
  throw err;
});

tryListen();
