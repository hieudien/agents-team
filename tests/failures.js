const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('../lib/store');
const { classify } = require('../lib/errors');
const Orchestrator = require('../lib/orchestrator');
const config = require('../config.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

assert.strictEqual(classify("You've hit your limit · resets 3pm"), 'usage_limit');
assert.strictEqual(classify('api_error: usage_limit_reached'), 'usage_limit');
assert.strictEqual(classify('API Error: 529 overloaded_error'), 'transient');
assert.strictEqual(classify('connect ECONNRESET'), 'transient');
assert.strictEqual(classify('Not logged in · Please run /login'), 'auth');
assert.strictEqual(classify('no structured output'), 'other');
console.log('classify OK');

const tmp = os.tmpdir();
const countCalls = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('=====').filter(s => s.trim()).length : 0);

async function scenario(name, env, cfg, waitFor) {
  const log = path.join(tmp, `failures-${name}.log`);
  fs.rmSync(log, { force: true });
  Object.assign(process.env, { MOCK_LOG: log }, env);
  const workspace = fs.mkdtempSync(path.join(tmp, 'fail-ws-'));
  const project = store.createProject({ name: `fail-${name}`, workspace });
  const orchestrator = new Orchestrator({ ...config, retryDelaysMs: [5, 5, 5], ...cfg }, { mock: true });
  const conv = orchestrator.handleUserMessage(project.id, '', 'Làm trang chủ');
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    if (waitFor(store.readChat(project.id, conv.id, 300), orchestrator)) break;
  }
  await sleep(300);
  const chat = store.readChat(project.id, conv.id, 300);
  const result = { calls: countCalls(log), chat, orchestrator };
  orchestrator.stopAll();
  for (const key of Object.keys(env)) delete process.env[key];
  return result;
}

(async () => {
  const limit = await scenario('limit', { MOCK_MODE: 'usage-limit' }, {}, (chat, o) => o.limited());
  assert.strictEqual(limit.calls, 1, 'usage limit must not be retried');
  assert(limit.chat.some(m => m.type === 'system' && /quota/i.test(m.text)));
  console.log('usage limit OK (1 call, queue paused)');

  const transient = await scenario('transient', { MOCK_MODE: 'transient-once', MOCK_STATE: path.join(tmp, `transient-${Date.now()}`) }, {}, chat => chat.some(m => m.type === 'report'));
  assert(transient.chat.some(m => m.type === 'report'));
  assert.strictEqual(transient.calls, 6, 'one retried call plus the normal 5');
  console.log('transient retry OK (6 calls)');

  const streak = await scenario('streak', { MOCK_MODE: 'error' }, { maxConsecutiveFailures: 2 }, chat => chat.some(m => /lỗi CLI liên tiếp/.test(m.text || '')));
  assert.strictEqual(streak.calls, 2);
  assert(streak.chat.some(m => /lỗi CLI liên tiếp/.test(m.text || '')));
  console.log('failure streak OK (2 calls then stop)');
  process.exit(0);
})();
