const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('../lib/store');
const verify = require('../lib/verify');
const Orchestrator = require('../lib/orchestrator');
const config = require('../config.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = os.tmpdir();

const ws = scripts => {
  const dir = fs.mkdtempSync(path.join(tmp, 'gate-ws-'));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
};

const pkgWith = test => JSON.stringify({ name: 'x', scripts: test ? { test } : {} });
assert.strictEqual(verify.detect(ws({ 'package.json': pkgWith('node t.js') })), 'npm test');
assert.strictEqual(verify.detect(ws({ 'package.json': pkgWith('echo "Error: no test specified" && exit 1') })), '');
assert.strictEqual(verify.detect(ws({ 'package.json': pkgWith('') })), '');
assert.strictEqual(verify.detect(ws({})), '');
assert.strictEqual(verify.resolveCommand({ workspace: ws({ 'package.json': pkgWith('node t.js') }) }, true), '');
assert.strictEqual(verify.resolveCommand({ workspace: ws({}), verifyCmd: 'make test' }, true), 'make test');
console.log('detect OK');

async function scenario(name, scripts, verifyCmd, cfg) {
  const log = path.join(tmp, `gate-${name}.log`);
  fs.rmSync(log, { force: true });
  process.env.MOCK_LOG = log;
  const project = store.createProject({ name: `gate-${name}`, workspace: ws(scripts), verifyCmd });
  const orchestrator = new Orchestrator({ ...config, ...cfg }, { mock: true });
  const conv = orchestrator.handleUserMessage(project.id, '', 'Làm trang chủ');
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (store.readChat(project.id, conv.id, 300).some(m => m.type === 'report')) break;
  }
  await sleep(300);
  const chat = store.readChat(project.id, conv.id, 300);
  const prompts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('=====').filter(s => s.trim()) : [];
  const tasks = orchestrator.tasks.filter(t => t.conversationId === conv.id);
  orchestrator.stopAll();
  delete process.env.MOCK_LOG;
  return { chat, prompts, tasks };
}

(async () => {
  const pass = await scenario('pass', { 'ok.js': 'process.exit(0)' }, 'node ok.js', {});
  assert(pass.chat.some(m => m.type === 'report'));
  assert(pass.chat.some(m => m.type === 'system' && /Kiểm tra tự động đạt: node ok\.js/.test(m.text)));
  assert(pass.prompts.some(p => p.includes('# Task') && p.includes('Server ran "node ok.js"') && p.includes('passed')), 'tester prompt carries the server check');
  console.log('passing check OK (tester told the server ran it)');

  const fail = await scenario('fail', { 'bad.js': 'console.error("boom from test");process.exit(1)' }, 'node bad.js', { maxGateRetries: 2 });
  assert(fail.chat.some(m => m.type === 'system' && /Kiểm tra tự động của .* chưa đạt/.test(m.text)));
  assert(fail.prompts.some(p => p.includes('## Feedback from the previous attempt') && p.includes('boom from test') && p.includes('exit code 1')), 'dev gets the failing output');
  assert(fail.tasks.some(t => /^Kiểm tra tự động không đạt sau nhiều lần/.test(t.title) && t.to === 'manager'), 'escalates to the manager after the retries');
  console.log('failing check OK (dev retried with output, then manager)');

  const slow = await scenario('slow', { 'slow.js': 'setTimeout(() => {}, 60000)' }, 'node slow.js', { maxGateRetries: 2, verify: { enabled: true, timeoutSeconds: 1, outputChars: 2000 } });
  assert(slow.prompts.some(p => p.includes('## Feedback from the previous attempt') && p.includes('timed out')), 'timeout is reported to the dev');
  console.log('timeout OK');

  const off = await scenario('off', { 'bad.js': 'process.exit(1)' }, 'node bad.js', { verify: { enabled: false } });
  assert(off.chat.some(m => m.type === 'report'));
  assert(!off.chat.some(m => m.type === 'system' && /Kiểm tra tự động/.test(m.text)));
  console.log('disabled OK');
  process.exit(0);
})();
