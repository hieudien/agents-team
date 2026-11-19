const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('../lib/store');
const Orchestrator = require('../lib/orchestrator');
const config = require('../config.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const argsLog = path.join(os.tmpdir(), 'bugloop-args.log');
  fs.rmSync(argsLog, { force: true });
  Object.assign(process.env, { MOCK_MODE: 'bug-loop', MOCK_ARGS_LOG: argsLog });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bugloop-ws-'));
  const project = store.createProject({ name: 'bugloop', workspace });
  const orchestrator = new Orchestrator({ ...config, maxBugRounds: 3, bugEscalation: { afterRound: 2, effort: 'high', model: null } }, { mock: true });
  const conv = orchestrator.handleUserMessage(project.id, '', 'Làm trang chủ');
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (store.readChat(project.id, conv.id, 300).some(m => m.type === 'report')) break;
  }
  await sleep(300);
  const chat = store.readChat(project.id, conv.id, 300);
  const tasks = orchestrator.tasks.filter(t => t.conversationId === conv.id);
  orchestrator.stopAll();

  const devBugTasks = tasks.filter(t => t.to.startsWith('dev') && t.bugRound > 0);
  assert.deepStrictEqual([...new Set(devBugTasks.map(t => t.bugRound))].sort(), [1, 2], 'dev must get bug rounds 1 and 2 only');
  assert(!tasks.some(t => t.to.startsWith('dev') && t.bugRound >= 3), 'no dev task after the cap');
  const escalated = tasks.find(t => /^Kẹt vòng sửa bug/.test(t.title));
  assert(escalated, 'third bug report must go to the manager');
  assert.strictEqual(escalated.to, 'manager');
  assert(/Bug report 1:/.test(escalated.task) && /Bug report 3:/.test(escalated.task), 'manager sees the full bug history');
  assert(chat.some(m => m.type === 'system' && /Vòng sửa bug/.test(m.text)));
  assert(chat.some(m => m.type === 'report'), 'manager finishes with a report');
  console.log('bug round cap OK (dev rounds 1-2, manager on report 3)');

  const calls = fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const effortOf = args => args[args.indexOf('--effort') + 1];
  const high = calls.filter(a => effortOf(a) === 'high').length;
  assert(high >= 1, 'dev effort must rise from the second bug round');
  assert(!calls.slice(0, 3).some(a => effortOf(a) === 'high'), 'first calls stay at normal effort');
  console.log(`effort escalation OK (${high} high-effort calls)`);
  process.exit(0);
})();
