const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const agents = require('./lib/agents');
const Orchestrator = require('./lib/orchestrator');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const mock = process.argv.includes('--mock');
const orchestrator = new Orchestrator(config, { mock });
const clients = new Set();

orchestrator.on('event', event => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 25e6) {
        reject(new Error('Dữ liệu gửi lên quá lớn'));
        req.destroy();
      }
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function serveUpload(url, res) {
  const [, , projectId, file] = url.pathname.split('/');
  const full = path.join(store.uploadsDir(path.basename(projectId || '')), path.basename(file || ''));
  if (!file || !fs.existsSync(full)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(full)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
  fs.createReadStream(full).pipe(res);
}

function serveStatic(req, res) {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const routes = [
  ['GET', /^\/api\/state$/, () => ({ projects: store.listProjects(), agents: orchestrator.agentStates(), mock })],
  ['POST', /^\/api\/projects$/, (m, body) => {
    if (!body.workspace) throw new Error('workspace is required');
    return store.createProject(body);
  }],
  ['GET', /^\/api\/projects\/([\w-]+)\/conversations$/, m => orchestrator.conversationStates(m[1])],
  ['POST', /^\/api\/projects\/([\w-]+)\/conversations$/, (m, body) => {
    const conv = store.createConversation(m[1], body.title);
    orchestrator.emitConversations(m[1]);
    return conv;
  }],
  ['POST', /^\/api\/projects\/([\w-]+)\/conversations\/([\w-]+)\/rename$/, (m, body) => {
    const conv = store.updateConversation(m[1], m[2], { title: String(body.title || '').slice(0, 60) || 'Không tên', autoTitle: false });
    orchestrator.emitConversations(m[1]);
    return conv;
  }],
  ['GET', /^\/api\/projects\/([\w-]+)\/conversations\/([\w-]+)\/chat$/, (m, body, url) => store.readChat(m[1], m[2], Number(url.searchParams.get('limit')) || 300)],
  ['POST', /^\/api\/projects\/([\w-]+)\/uploads$/, (m, body) => store.saveUpload(m[1], body.name, body.dataUrl)],
  ['POST', /^\/api\/projects\/([\w-]+)\/messages$/, (m, body) => {
    const attachments = store.resolveAttachments(m[1], body.attachments);
    const text = String(body.text || '').trim() || (attachments.length ? '(Ảnh đính kèm)' : '');
    if (!text) throw new Error('Tin nhắn trống');
    const conv = orchestrator.handleUserMessage(m[1], body.conversationId, text, attachments);
    return { ok: true, conversationId: conv.id };
  }],
  ['GET', /^\/api\/agents\/([\w-]+)$/, m => agents.agentDetails(m[1]) || Promise.reject(new Error('agent not found'))],
  ['POST', /^\/api\/agents$/, (m, body) => orchestrator.createAgent(body.role, body.reason, body.projectId, body.conversationId)],
  ['POST', /^\/api\/agents\/([\w-]+)\/reset-session$/, (m, body) => {
    agents.setSession(m[1], body.projectId, null);
    return { ok: true };
  }],
  ['POST', /^\/api\/stop$/, () => {
    orchestrator.stopAll();
    return { ok: true };
  }]
];

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    orchestrator.toast(`Lỗi server: ${e.message}`);
    if (!res.headersSent) send(res, 500, { error: e.message });
  });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'agents', agents: orchestrator.agentStates() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname.startsWith('/uploads/')) return serveUpload(url, res);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  for (const [method, pattern, handler] of routes) {
    const m = url.pathname.match(pattern);
    if (!m || req.method !== method) continue;
    try {
      const body = method === 'POST' ? await readBody(req) : {};
      return send(res, 200, await handler(m, body, url));
    } catch (e) {
      return send(res, 400, { error: e.message || String(e) });
    }
  }
  send(res, 404, { error: 'not found' });
}

process.on('unhandledRejection', e => orchestrator.toast(`Lỗi không mong muốn: ${e && e.message ? e.message : e}`));
process.on('uncaughtException', e => orchestrator.toast(`Lỗi không mong muốn: ${e.message}`));

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Cổng ${config.port} đang được dùng. Tắt server cũ hoặc đổi "port" trong config.json.` : e.message);
  process.exit(1);
});

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25000);

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Agent team running at http://localhost:${config.port}${mock ? ' (mock mode)' : ''}`);
});
