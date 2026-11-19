const assert = require('assert');
const claude = require('../lib/claude');
const config = require('../config.json');

const cases = [
  { name: 'manager', mode: 'work', roleCfg: config.roles.manager, browser: false },
  { name: 'comment', mode: 'comment', roleCfg: { model: 'haiku', lightweight: true }, browser: false },
  { name: 'dev (no browser)', mode: 'work', roleCfg: config.roles.dev, browser: false, resume: true },
  { name: 'dev (browser)', mode: 'work', roleCfg: config.roles.dev, browser: true, resume: false },
  { name: 'tester (no browser)', mode: 'work', roleCfg: config.roles.tester, browser: false },
  { name: 'tester (browser)', mode: 'work', roleCfg: config.roles.tester, browser: true }
];

const results = {};
for (const c of cases) {
  const args = claude.buildArgs({ mode: c.mode, roleCfg: c.roleCfg, systemFile: 'sys.md', extraDirs: ['x'], sessionId: 'sid', resume: !!c.resume, browser: c.browser });
  results[c.name] = args;
  console.log(`${c.name}:\n  ${args.map(a => (a === '' ? '""' : a)).filter(a => !a.startsWith('{')).join(' ')}\n`);
}

const has = (n, f) => results[n].includes(f);
const toolsOf = n => results[n][results[n].indexOf('--tools') + 1];

for (const n of ['manager', 'comment']) {
  assert(has(n, '--system-prompt-file'), `${n}: --system-prompt-file`);
  assert(!has(n, '--append-system-prompt-file'), `${n}: no append`);
  assert.strictEqual(toolsOf(n), '', `${n}: --tools ""`);
  assert(!has(n, '--mcp-config'), `${n}: no mcp`);
  assert(has(n, '--disable-slash-commands'), `${n}: slash commands off`);
  assert(has(n, '--no-session-persistence'), `${n}: no session`);
  assert(!has(n, '--resume'), `${n}: no resume`);
}
assert(!has('dev (no browser)', '--mcp-config'));
assert(has('dev (browser)', '--mcp-config'));
assert(!has('tester (no browser)', '--mcp-config'));
assert(has('tester (browser)', '--mcp-config'));
assert(has('dev (no browser)', '--resume'));
assert(!has('tester (browser)', '--resume') && has('tester (browser)', '--no-session-persistence'));
assert(!has('dev (no browser)', '--system-prompt-snapshot'));
assert(has('dev (no browser)', '--exclude-dynamic-system-prompt-sections'));
console.log('args OK');
