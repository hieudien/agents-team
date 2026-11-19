const fs = require('fs');

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const system = fs.readFileSync(arg('--append-system-prompt-file') || arg('--system-prompt-file'), 'utf8');
if (process.env.MOCK_ARGS_LOG) fs.appendFileSync(process.env.MOCK_ARGS_LOG, JSON.stringify(args) + '\n');
const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 800 };
const cost = 0.0123;
const agentId = (system.match(/agent id: ([\w-]+)/) || [])[1];
const role = (system.match(/# Role rules \((\w+)\)/) || [])[1] || (system.match(/agent id: ([a-z]+)/) || [])[1];
const sessionId = arg('--session-id') || arg('--resume');

let prompt = '';
process.stdin.on('data', d => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, prompt + '\n=====\n');
  const fail = result => process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result }) + '\n');
  const mode = process.env.MOCK_MODE;
  if (mode === 'usage-limit') return fail("You've hit your limit · resets 3pm");
  if (mode === 'error') return fail('unexpected failure in mock');
  if (mode === 'transient-once' && process.env.MOCK_STATE && !fs.existsSync(process.env.MOCK_STATE)) {
    fs.writeFileSync(process.env.MOCK_STATE, '1');
    return fail('API Error: 529 overloaded_error');
  }
  const from = (prompt.match(/^From: .*\(([\w-]+)\)$/m) || [])[1];
  const required = (prompt.split('## Required checklist')[1] || '').split('##')[0].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
  const retry = prompt.includes('## Feedback from the previous attempt');
  const pass = items => items.map(item => ({ item, pass: true, evidence: 'mock verified' }));
  let out;

  if (arg('--json-schema').includes('speak')) {
    const review = prompt.startsWith('# Review') || prompt.startsWith('# Diff review');
    const speak = review ? role === 'tester' : ['dev', 'tester'].includes(role);
    const chat = !speak ? '' : review ? 'Câu trả lời thiếu bước test trên mobile, nên thêm kiểm tra width 390px.' : role === 'dev' ? 'Góp ý: nên dùng HTML tĩnh cho nhanh, không cần framework.' : 'Tôi sẽ cần tiêu chí nghiệm thu rõ để test nhé.';
    return setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { speak, chat }, usage, total_cost_usd: cost }) + '\n'), 300);
  }

  if (prompt.includes('The user tagged you directly')) {
    out = { chat: `Tôi (${agentId}) trả lời trực tiếp: đã xem yêu cầu, đây là ý kiến của tôi.`, status: 'done', checklist: pass(['Answered the user directly']), handoffs: [], report_to_user: 'Trả lời trực tiếp cho bạn.' };
    return setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: out, session_id: sessionId, usage, total_cost_usd: cost }) + '\n'), 300);
  }

  if (role === 'manager' && from === 'user') {
    out = {
      chat: 'Chào bạn, tôi đã hiểu yêu cầu, giao @DEV làm trang, xong thì @TESTER test.',
      status: 'done',
      checklist: pass(['Request understood', 'No invented requirements', 'Tasks have clear scope']),
      handoffs: [{ to: 'dev', title: 'Create index.html', task: 'Create index.html with a hero section', checklist: ['Page renders without console errors', 'No code comments'] }],
      memory_add: ['User prefers short reports'],
      propose_agent: { role: 'dev', reason: 'Demo: dev queue may grow, suggest one more dev.' }
    };
  } else if (role === 'manager' && from && from.startsWith('dev')) {
    out = { chat: '@TESTER ơi test giúp trang mới nhé.', status: 'done', checklist: pass(['Tester assigned']), handoffs: [{ to: 'tester-1', title: 'Test index.html', task: 'Open the page and verify', checklist: ['Page renders without console errors'] }] };
  } else if (role === 'manager') {
    out = { chat: 'Mọi thứ đã đạt, tôi gửi báo cáo cho bạn.', status: 'done', checklist: pass(['Report matches acceptance criteria']), handoffs: [], report_to_user: 'Kết quả: landing page chạy được.\nĐã kiểm tra: tester pass.' };
  } else if (role === 'dev') {
    const list = pass(required);
    if (!retry) list.push({ item: 'Console has no errors', pass: false, evidence: 'found 1 error' });
    out = {
      chat: retry ? 'Sửa xong lỗi console, đã tự test lại, gửi @PM nhé.' : 'Xong bản đầu, còn 1 lỗi console để tôi sửa.',
      status: 'done',
      checklist: list,
      handoffs: [{ to: 'manager', title: 'index.html ready for test', task: 'Changed index.html. Run npx serve. URL http://localhost:5500', checklist: ['Page renders without console errors'] }],
      concerns: ['Layout not checked below 390px width'],
      memory_add: ['Project uses plain HTML']
    };
  } else if (mode === 'bug-loop') {
    out = { chat: 'Phát hiện bug, báo dev nhé.', status: 'done', checklist: pass(required), handoffs: [{ to: 'manager', title: 'Bug: button does nothing', task: 'Steps: click the button. Expected: modal opens. Actual: nothing happens.', checklist: ['Bug is fixed'], verdict: 'bug' }] };
  } else {
    out = { chat: 'Test hết checklist, pass cả nhé!', status: 'done', checklist: pass(required), handoffs: [{ to: 'manager', title: 'Pass: index.html', task: 'All items passed', checklist: [] }], concerns: ['Not tested on Safari'] };
  }

  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: out, session_id: sessionId, agent: agentId, usage, total_cost_usd: cost }) + '\n');
  }, 400);
});
