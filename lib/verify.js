const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NO_TEST_PLACEHOLDER = /no test specified/i;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function detect(workspace) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspace, 'package.json'), 'utf8'));
    const script = pkg.scripts && pkg.scripts.test;
    return script && !NO_TEST_PLACEHOLDER.test(script) ? 'npm test' : '';
  } catch {
    return '';
  }
}

function resolveCommand(project, mock, autoDetect) {
  const explicit = String(project.verifyCmd || '').trim();
  if (explicit) return explicit;
  // Auto-detected scripts come from files the dev agent can edit, so they only run when opted in.
  return mock || !autoDetect ? '' : detect(project.workspace);
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {}
}

function run(command, cwd, { timeoutMs, maxChars, onSpawn }) {
  return new Promise(resolve => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let finished = false;
    let child;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, output: output.replace(ANSI, '').slice(-maxChars).trim(), seconds: Math.round((Date.now() - started) / 1000) });
    };
    let timer;
    let grace;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    } catch (e) {
      output = e.message;
      return finish(null);
    }
    if (onSpawn) onSpawn(child);
    const keep = d => {
      output = (output + d).slice(-maxChars * 3);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      grace = setTimeout(() => finish(null), 3000);
    }, timeoutMs);
    child.on('error', e => {
      output += e.message;
      finish(null);
    });
    child.on('close', finish);
  });
}

module.exports = { detect, resolveCommand, run, killTree };
