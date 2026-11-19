const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const port = Number(process.argv[3]) || 3940;
const text = process.argv[4] || 'Làm landing page cho quán cà phê';
const logFile = path.join(os.tmpdir(), `flow-${port}.log`);
const argsFile = path.join(os.tmpdir(), `flow-args-${port}.log`);
for (const f of [logFile, argsFile]) fs.rmSync(f, { force: true });

const api = (method, url, body) =>
  fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = spawn(process.execPath, ['server.js', '--mock'], { cwd: root, env: { ...process.env, PORT: String(port), MOCK_LOG: logFile, MOCK_ARGS_LOG: argsFile }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 30; i++) {
      try {
        await api('GET', '/api/state');
        break;
      } catch {
        await sleep(200);
      }
    }
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ws-'));
    const project = await api('POST', '/api/projects', { name: 'flow', workspace });
    const res = await api('POST', `/api/projects/${project.id}/messages`, { text });
    let chat = [];
    for (let i = 0; i < 80; i++) {
      await sleep(500);
      chat = await api('GET', `/api/projects/${project.id}/conversations/${res.conversationId}/chat?limit=300`);
      if (chat.some(m => m.type === 'report')) break;
    }
    await sleep(1500);
    chat = await api('GET', `/api/projects/${project.id}/conversations/${res.conversationId}/chat?limit=300`);
    const calls = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('=====').filter(s => s.trim()).length : 0;
    console.log(JSON.stringify({ calls, report: chat.some(m => m.type === 'report'), speakers: chat.filter(m => m.type === 'agent').map(m => `${m.from}${m.data && m.data.kind ? ':' + m.data.kind : ''}`), withUsage: chat.filter(m => m.data && m.data.usage).length }));
  } finally {
    server.kill();
  }
})();
