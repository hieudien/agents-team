const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const store = require('./store');
const { classify } = require('./errors');

const SCHEMAS = {
  work: JSON.stringify(require('../team/output.schema.json')),
  comment: JSON.stringify(require('../team/comment.schema.json'))
};

let resolved = null;

function resolveClaude(config, mock) {
  if (mock) return { cmd: process.execPath, pre: [path.join(store.ROOT, 'tests', 'mock-claude.js')] };
  if (resolved) return resolved;
  if (config.claudeBin) return (resolved = { cmd: config.claudeBin, pre: [] });
  if (process.platform !== 'win32') return (resolved = { cmd: 'claude', pre: [] });
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'claude.exe')];
  try {
    const found = execFileSync('where', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    for (const f of found) {
      if (f.toLowerCase().endsWith('.exe')) candidates.push(f);
      if (f.toLowerCase().endsWith('.cmd')) {
        candidates.push(path.join(path.dirname(f), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
      }
    }
  } catch {}
  const hit = candidates.find(c => fs.existsSync(c));
  if (!hit) throw new Error('Không tìm thấy Claude Code CLI (claude.exe). Cài Claude Code, chạy "claude" một lần để đăng nhập, hoặc điền đường dẫn vào "claudeBin" trong config.json.');
  return (resolved = { cmd: hit, pre: [] });
}

function mcpConfigFile() {
  const file = path.join(store.DATA, 'runtime', 'mcp.playwright.json');
  const server =
    process.platform === 'win32'
      ? { command: 'cmd', args: ['/c', 'npx', '-y', '@playwright/mcp@latest'] }
      : { command: 'npx', args: ['-y', '@playwright/mcp@latest'] };
  store.writeJson(file, { mcpServers: { playwright: server } });
  return file;
}

const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 8000];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function runOnce(options) {
  try {
    return spawnClaude(options);
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message, durationMs: 0 });
  }
}

async function runClaude(options) {
  const delays = options.config.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  let current = options;
  for (let attempt = 0; ; attempt++) {
    const result = await runOnce(current);
    if (result.ok) return result;
    result.kind = classify(result.error);
    const cancelled = options.isCancelled && options.isCancelled();
    if (result.kind !== 'transient' || attempt >= delays.length || cancelled) return result;
    await sleep(delays[attempt]);
    // The failed attempt may already have created its --session-id; a fresh run needs a new one.
    if (!current.resume) current = { ...current, sessionId: newSessionId() };
  }
}

function buildArgs({ pre = [], mode = 'work', roleCfg, systemFile, extraDirs, sessionId, resume, browser, settingSources = 'project' }) {
  const light = mode === 'comment' || !!roleCfg.lightweight;
  const args = [
    ...pre,
    '-p',
    '--output-format', 'json',
    '--json-schema', SCHEMAS[mode],
    '--permission-prompts', 'none',
    '--permission-mode', roleCfg.permissionMode || 'default',
    '--model', roleCfg.model || 'sonnet',
    '--strict-mcp-config'
  ];
  if (settingSources) args.push('--setting-sources', settingSources);
  if (light) {
    const tools = roleCfg.lightTools || '';
    args.push('--system-prompt-file', systemFile, '--tools', tools, '--disable-slash-commands');
    if (tools) {
      args.push('--allowedTools', tools);
      for (const d of extraDirs || []) args.push('--add-dir', d);
    }
  } else {
    args.push('--append-system-prompt-file', systemFile, '--exclude-dynamic-system-prompt-sections', '--tools', roleCfg.tools || 'default');
    if (roleCfg.allowedTools && roleCfg.allowedTools.length) args.push('--allowedTools', roleCfg.allowedTools.join(','));
    if (browser) args.push('--mcp-config', mcpConfigFile());
    for (const d of extraDirs || []) args.push('--add-dir', d);
  }
  if (roleCfg.effort) args.push('--effort', roleCfg.effort);
  if (mode === 'comment' || !roleCfg.resume) args.push('--no-session-persistence');
  else if (resume) args.push('--resume', sessionId);
  else args.push('--session-id', sessionId);
  return args;
}

function spawnClaude({ config, mock, agent, roleCfg, systemFile, prompt, cwd, sessionId, resume, extraDirs, browser, onSpawn, mode = 'work' }) {
  const { cmd, pre } = resolveClaude(config, mock);
  const args = buildArgs({ pre, mode, roleCfg, systemFile, extraDirs, sessionId, resume, browser, settingSources: config.settingSources === undefined ? 'project' : config.settingSources });

  fs.mkdirSync(cwd, { recursive: true });
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, AGENT_ID: agent.id }, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message, durationMs: 0 });
    }
    if (onSpawn) onSpawn(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), config.runTimeoutMinutes * 60000);
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, durationMs: Date.now() - started });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      let raw;
      try {
        raw = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
      } catch {
        return resolve({ ok: false, error: (err || out || `exit ${code}`).slice(-800), durationMs });
      }
      const output = extractOutput(raw);
      if (raw.is_error || !output) {
        return resolve({
          ok: false,
          error: String(raw.result || raw.subtype || err || 'no structured output').slice(-800),
          sessionId: raw.session_id,
          durationMs
        });
      }
      resolve({
        ok: true,
        output,
        sessionId: mode === 'comment' || !roleCfg.resume ? null : raw.session_id || sessionId,
        usage: normalizeUsage(raw.usage),
        costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : null,
        durationMs
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function normalizeUsage(u) {
  if (!u) return null;
  const n = k => Number(u[k]) || 0;
  return { input: n('input_tokens'), output: n('output_tokens'), cacheRead: n('cache_read_input_tokens'), cacheCreate: n('cache_creation_input_tokens') };
}

function extractOutput(raw) {
  if (raw.structured_output && typeof raw.structured_output === 'object') return raw.structured_output;
  const text = String(raw.result || '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function newSessionId() {
  return crypto.randomUUID();
}

module.exports = { runClaude, newSessionId, resolveClaude, buildArgs };
