// Local preview: serves the site and answers API calls with Code.gs running on a fixture.
// Usage: FIXTURE=/path/to/fixture.json PORT=8080 node test/dev-server.js
// Signs in automatically with a test token, so it never talks to Google.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadGas, TEST_TOKENS } = require('./gas-mock');

const root = path.join(__dirname, '..');
const gas = loadGas({ fixture: process.env.FIXTURE, tokens: TEST_TOKENS });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gas.call(JSON.parse(body || '{}'))));
    });
    return;
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(`window.APP_CONFIG = { apiUrl: '/exec', clientId: 'test-client', defaultFy: '26-27', devToken: '${process.env.DEV_TOKEN || 'tok-jorge'}' };`);
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || /[\\/](test|\.git)[\\/]/.test(file.slice(root.length)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 8080), () => console.log('http://localhost:' + (process.env.PORT || 8080)));
