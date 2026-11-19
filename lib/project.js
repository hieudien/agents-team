const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', 'data', 'out', 'target', 'vendor', '__pycache__']);
const MAX_ENTRIES = 60;
const MAX_DEPTH = 2;
const README_CHARS = 1500;
const TTL_MS = 60000;
const cache = new Map();

function listTree(dir, depth, lines) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (lines.length >= MAX_ENTRIES) return;
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    lines.push(`${'  '.repeat(depth)}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory() && depth + 1 < MAX_DEPTH) listTree(path.join(dir, e.name), depth + 1, lines);
  }
}

function readmeHead(workspace) {
  for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
    try {
      return fs.readFileSync(path.join(workspace, name), 'utf8').slice(0, README_CHARS).trim();
    } catch {}
  }
  return '';
}

function overview(workspace) {
  const hit = cache.get(workspace);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  const lines = [];
  listTree(workspace, 0, lines);
  const readme = readmeHead(workspace);
  const text = ['## Project overview (files cannot be read in this run; ask a dev if you need more)', lines.length ? lines.join('\n') : '(empty workspace)', readme ? `\nREADME (start):\n${readme}` : ''].join('\n');
  cache.set(workspace, { at: Date.now(), text });
  return text;
}

const DIFF_MAX_CHARS = 6000;

function git(workspace, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: workspace, encoding: 'utf8', timeout: 8000, maxBuffer: 4e6, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function gitDiff(workspace) {
  const status = (await git(workspace, ['status', '--short'])).split('\n').slice(0, 40).join('\n').trim();
  if (!status) return '';
  const diff = (await git(workspace, ['diff', 'HEAD'])) || (await git(workspace, ['diff']));
  return `${status}\n\n${diff}`.slice(0, DIFF_MAX_CHARS);
}

module.exports = { overview, gitDiff };
