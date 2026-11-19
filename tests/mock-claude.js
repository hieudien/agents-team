const fs = require('fs');

const args = process.argv.slice(2);
const arg = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : '';
};

const system = fs.readFileSync(arg('--append-system-prompt-file'), 'utf8');
const agentId = (system.match(/agent id: ([\w-]+)/) || [])[1];
const role = (system.match(/# Role rules \((\w+)\)/) || [])[1];
const sessionId = arg('--session-id') || arg('--resume');

let prompt = '';
process.stdin.on('data', d => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.MOCK_LOG) fs.appendFileSync(process.env.MOCK_LOG, prompt + '\n=====\n');
  const from = (prompt.match(/^From: .*\(([\w-]+)\)$/m) || [])[1];
  const required = (prompt.split('## Required checklist')[1] || '').split('##')[0].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
  const retry = prompt.includes('## Feedback from the previous attempt');
  const pass = items => items.map(item => ({ item, pass: true, evidence: 'mock verified' }));
  let out;

  if (arg('--json-schema').includes('speak')) {
    const review = prompt.startsWith('# Review');
    const speak = review ? role === 'tester' : ['dev', 'tester'].includes(role);
    const chat = !speak ? '' : review ? 'Câu trả lời thiếu bước test trên mobile, nên thêm kiểm tra width 390px.' : role === 'dev' ? 'Góp ý: nên dùng HTML tĩnh cho nhanh, không cần framework.' : 'Mình sẽ cần tiêu chí nghiệm thu rõ để test nhé.';
    return setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { speak, chat } }) + '\n'), 300);
  }

  if (prompt.includes('The user tagged you directly')) {
    out = { chat: `Mình (${agentId}) trả lời trực tiếp: đã xem yêu cầu, đây là ý kiến của mình.`, status: 'done', checklist: pass(['Answered the user directly']), handoffs: [], report_to_user: 'Trả lời trực tiếp cho anh Hiếu.' };
    return setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: out, session_id: sessionId }) + '\n'), 300);
  }

  if (role === 'manager' && from === 'user') {
    out = {
      chat: 'Chào anh Hiếu, em đã hiểu yêu cầu, chuyển @Cora chia việc nhé.',
      status: 'done',
      checklist: pass(['Request understood', 'No invented requirements']),
      handoffs: [{ to: 'coordinator', title: 'Build landing page', task: 'Goal from the user request', checklist: ['Page renders without console errors'] }],
      memory_add: ['User prefers short reports']
    };
  } else if (role === 'manager') {
    out = { chat: 'Mọi thứ đã đạt, em gửi báo cáo cho anh.', status: 'done', checklist: pass(['Report matches acceptance criteria']), handoffs: [], report_to_user: 'Kết quả: landing page chạy được.\nĐã kiểm tra: tester pass.' };
  } else if (role === 'coordinator' && from === 'manager') {
    out = {
      chat: 'Mình giao @Devin làm trang, xong thì @Tessa test.',
      status: 'done',
      checklist: pass(['Tasks have clear scope']),
      handoffs: [{ to: 'dev', title: 'Create index.html', task: 'Create index.html with a hero section', checklist: ['Page renders without console errors', 'No code comments'] }],
      propose_agent: { role: 'dev', reason: 'Demo: dev queue may grow, suggest one more dev.' }
    };
  } else if (role === 'coordinator' && from && from.startsWith('dev')) {
    out = { chat: '@Tessa ơi test giúp trang mới nhé.', status: 'done', checklist: pass(['Tester assigned']), handoffs: [{ to: 'tester-1', title: 'Test index.html', task: 'Open the page and verify', checklist: ['Page renders without console errors'] }] };
  } else if (role === 'coordinator') {
    out = { chat: 'Test pass rồi, báo @Max nhé.', status: 'done', checklist: pass(['All tasks passed testing']), handoffs: [{ to: 'manager', title: 'Goal finished', task: 'index.html done and tested', checklist: [] }] };
  } else if (role === 'dev') {
    const list = pass(required);
    if (!retry) list.push({ item: 'Console has no errors', pass: false, evidence: 'found 1 error' });
    out = {
      chat: retry ? 'Sửa xong lỗi console, đã tự test lại, gửi @Cora nhé.' : 'Xong bản đầu, còn 1 lỗi console để mình sửa.',
      status: 'done',
      checklist: list,
      handoffs: [{ to: 'coordinator', title: 'index.html ready for test', task: 'Changed index.html. Run npx serve. URL http://localhost:5500', checklist: ['Page renders without console errors'] }],
      memory_add: ['Project uses plain HTML']
    };
  } else {
    out = { chat: 'Test hết checklist, pass cả nhé!', status: 'done', checklist: pass(required), handoffs: [{ to: 'coordinator', title: 'Pass: index.html', task: 'All items passed', checklist: [] }] };
  }

  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: out, session_id: sessionId, agent: agentId }) + '\n');
  }, 400);
});
