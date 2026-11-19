const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('../lib/store');
const Orchestrator = require('../lib/orchestrator');
const config = require('../config.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const log = path.join(os.tmpdir(), 'concerns.log');
  fs.rmSync(log, { force: true });
  process.env.MOCK_LOG = log;
  const project = store.createProject({ name: 'concerns', workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'concerns-ws-')) });
  const orchestrator = new Orchestrator({ ...config }, { mock: true });

  const dev = { role: 'dev', name: 'Dev' };
  const long = 'x'.repeat(500);
  const cleaned = orchestrator.cleanConcerns({ concerns: ['  a   b ', '', long, 'c', 'd', 'e', 'f', 'g'] }, dev);
  assert.strictEqual(cleaned.length, 5);
  assert.strictEqual(cleaned[0], 'a b');
  assert(cleaned.every(c => c.length <= 200));
  assert.deepStrictEqual(orchestrator.cleanConcerns({ concerns: ['x'] }, { role: 'manager', name: 'PM' }), []);
  assert.deepStrictEqual(orchestrator.cleanConcerns({}, dev), []);
  console.log('cleanConcerns OK');

  const conv = orchestrator.handleUserMessage(project.id, '', 'Làm trang chủ');
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    if (store.readChat(project.id, conv.id, 300).some(m => m.type === 'report')) break;
  }
  await sleep(300);
  const chat = store.readChat(project.id, conv.id, 300);
  const prompts = fs.readFileSync(log, 'utf8').split('=====').filter(s => s.trim());
  const tasks = orchestrator.tasks.filter(t => t.conversationId === conv.id);
  orchestrator.stopAll();

  assert(chat.some(m => m.type === 'report'), 'flow finishes with a report');
  const testerTask = tasks.find(t => t.to === 'tester-1' && t.kind === 'work');
  assert(testerTask.checklist.includes('Concern: Layout not checked below 390px width'), 'dev concern becomes a required tester checklist item');
  assert(/Concerns from .* \(check these first\)/.test(testerTask.task));
  const testerPrompt = prompts.find(p => p.includes(`# Task ${testerTask.id}`));
  assert(testerPrompt.includes('- Concern: Layout not checked below 390px width'));
  const managerFinal = tasks.filter(t => t.to === 'manager' && t.from === 'tester-1').pop();
  assert(managerFinal && managerFinal.task.includes('Not tested on Safari'), 'tester concerns reach the manager');
  assert(!managerFinal.checklist.some(c => /^Concern:/.test(c)), 'no required concern items for the manager');
  console.log('concerns flow OK (dev -> tester checklist, tester -> manager text)');
  process.exit(0);
})();
