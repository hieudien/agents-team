const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');
const store = require('../lib/store');
const Orchestrator = require('../lib/orchestrator');
const config = require('../config.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-ws-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'index.html'), '<h1>hi</h1>');
  const project = store.createProject({ name: 'diff-test', workspace });
  const orchestrator = new Orchestrator({ ...config, comments: { ...config.comments, adversarialDiff: true } }, { mock: true });
  const conv = orchestrator.handleUserMessage(project.id, '', 'Làm trang chủ đơn giản');
  let chat = [];
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    chat = store.readChat(project.id, conv.id, 300);
    if (chat.some(m => m.type === 'report')) break;
  }
  const diffTasks = orchestrator.tasks.filter(t => t.commentMode === 'diff' && t.projectId === project.id);
  const testerTask = orchestrator.tasks.find(t => t.to === 'tester-1' && t.kind === 'work' && t.projectId === project.id);
  console.log(JSON.stringify({ report: chat.some(m => m.type === 'report'), diffReviews: diffTasks.length, reviewNote: diffTasks[0] && diffTasks[0].reviewNote, testerWaitedFor: testerTask && testerTask.waitFor, reviewPosted: chat.some(m => m.data && m.data.kind === 'review') }));
  assert(chat.some(m => m.type === 'report'));
  assert.strictEqual(diffTasks.length, 1);
  assert(diffTasks[0].diffText.includes('index.html'));
  assert(/Concerns from .* \(check these first\)/.test(diffTasks[0].task) && diffTasks[0].task.includes('390px'), 'diff review sees the dev concerns');
  assert.deepStrictEqual(testerTask.waitFor, [diffTasks[0].id]);
  console.log('diff review OK');
  process.exit(0);
})();
