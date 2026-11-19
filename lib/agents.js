const fs = require('fs');
const path = require('path');
const store = require('./store');

const AGENTS_DIR = path.join(store.ROOT, 'agents');
const ROLES_DIR = path.join(store.ROOT, 'roles');
const TEAM_DIR = path.join(store.ROOT, 'team');
const RUNTIME_DIR = path.join(store.DATA, 'runtime');

const COLORS = ['#e07a5f', '#3d85c6', '#81b29a', '#f2a541', '#9b5de5', '#00a6a6', '#ef476f', '#6a994e'];

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs
    .readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => store.readJson(path.join(AGENTS_DIR, d.name, 'profile.json'), null))
    .filter(a => a && !a.retired)
    .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.id.localeCompare(b.id));
}

function roleOrder(role) {
  return { manager: 0, dev: 1, tester: 2 }[role] ?? 9;
}

function isRetired(id) {
  const agent = getAgent(id);
  return !!(agent && agent.retired);
}

function matchesAgent(agent, key) {
  const k = String(key).toLowerCase();
  return agent.id.toLowerCase() === k || agent.name.toLowerCase() === k || (agent.aliases || []).some(a => a.toLowerCase() === k);
}

function getAgent(id) {
  return store.readJson(path.join(AGENTS_DIR, id, 'profile.json'), null);
}

function agentDir(id) {
  return path.join(AGENTS_DIR, id);
}

function roleDir(role) {
  return path.join(ROLES_DIR, role);
}

function parseSkill(file) {
  const text = readText(file);
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  let name = path.basename(file, '.md');
  let description = '';
  if (match) {
    const n = match[1].match(/^name:\s*(.+)$/m);
    const d = match[1].match(/^description:\s*(.+)$/m);
    if (n) name = n[1].trim();
    if (d) description = d[1].trim();
  }
  return { name, description, file };
}

function listSkills(agent) {
  const dirs = [path.join(roleDir(agent.role), 'skills'), path.join(agentDir(agent.id), 'skills')];
  const skills = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.md')) skills.push(parseSkill(path.join(dir, f)));
    }
  }
  return skills;
}

function readMemory(id) {
  return readText(path.join(agentDir(id), 'MEMORY.md'));
}

const MEMORY_ITEMS_PER_TASK = 3;

function memoryKey(line) {
  return String(line).replace(/^-\s*\d{4}-\d{2}-\d{2}:\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function appendMemory(id, items, maxLines) {
  const file = path.join(agentDir(id), 'MEMORY.md');
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const known = new Set(lines.map(memoryKey));
  const fresh = [];
  const duplicates = [];
  for (const item of items || []) {
    const text = String(item).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (known.has(memoryKey(text))) {
      duplicates.push(text);
      continue;
    }
    known.add(memoryKey(text));
    fresh.push(text);
  }
  const wanted = fresh.slice(0, MEMORY_ITEMS_PER_TASK);
  const added = wanted.slice(0, Math.max(0, maxLines - lines.length));
  if (added.length) {
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(file, (raw && !raw.endsWith('\n') ? '\n' : '') + added.map(s => `- ${day}: ${s}`).join('\n') + '\n');
  }
  return { added, rejected: wanted.slice(added.length), duplicates, lines: lines.length + added.length };
}

let mockMode = false;

function setMock(value) {
  mockMode = !!value;
}

function worklogFile(id) {
  return mockMode ? path.join(store.DATA, 'mock', `${id}.worklog.jsonl`) : path.join(agentDir(id), 'worklog.jsonl');
}

function appendWorklog(id, entry) {
  store.appendJsonl(worklogFile(id), { ts: new Date().toISOString(), ...entry });
}

function readWorklog(id, limit) {
  return store.readJsonlTail(worklogFile(id), limit);
}

function usageTotals(id) {
  const total = { runs: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 };
  for (const w of readWorklog(id, 0)) {
    if (!w.usage) continue;
    total.runs++;
    total.input += w.usage.input || 0;
    total.output += w.usage.output || 0;
    total.cacheRead += w.usage.cacheRead || 0;
    total.cacheCreate += w.usage.cacheCreate || 0;
    total.costUsd += w.costUsd || 0;
  }
  return total;
}

function sessionsFile(id) {
  return path.join(agentDir(id), 'sessions.json');
}

function sessionKey(projectId, conversationId) {
  return `${projectId}/${conversationId}`;
}

function getSession(id, projectId, conversationId) {
  const entry = store.readJson(sessionsFile(id), {})[sessionKey(projectId, conversationId)];
  if (!entry) return null;
  return typeof entry === 'string' ? { id: entry, tasks: 0 } : entry;
}

function setSession(id, projectId, conversationId, sessionId, tasks = 0) {
  const all = store.readJson(sessionsFile(id), {});
  const key = sessionKey(projectId, conversationId);
  if (sessionId) all[key] = { id: sessionId, tasks };
  else delete all[key];
  store.writeJson(sessionsFile(id), all);
}

function clearSessions(id, projectId) {
  const all = store.readJson(sessionsFile(id), {});
  for (const key of Object.keys(all)) if (key === projectId || key.startsWith(`${projectId}/`)) delete all[key];
  store.writeJson(sessionsFile(id), all);
}

function teamRoster(agents) {
  return agents.map(a => `- ${a.id}: ${a.name}, ${a.title} (role: ${a.role})`).join('\n');
}

function buildSystemPrompt(agent, config, mode = 'work') {
  const roleCfg = config.roles[agent.role] || {};
  const light = mode === 'comment' || !!roleCfg.lightweight;
  const parts = [
    `# Identity`,
    `You are ${agent.name} (agent id: ${agent.id}), ${agent.title} in a software development team.`,
    `Bio: ${agent.bio}`,
    `Personality: ${agent.personality}`,
    ``,
    `# Global team rules`,
    readText(path.join(TEAM_DIR, 'RULES.md')),
    ``
  ];
  if (mode !== 'comment') {
    parts.push(`# Role rules (${agent.role})`, readText(path.join(roleDir(agent.role), 'RULES.md')), ``, `# Personal rules`, readText(path.join(agentDir(agent.id), 'RULES.md')) || '(none)', ``);
    if (!light) {
      const skills = listSkills(agent)
        .map(s => `- ${s.name}: ${s.description} (file: ${s.file})`)
        .join('\n');
      parts.push(`# Skills`, `Read a skill file with the Read tool before doing work it covers.`, skills || '(none)', ``);
    }
  }
  parts.push(`# Output contract`, readText(path.join(TEAM_DIR, mode === 'comment' ? 'COMMENT.md' : 'OUTPUT.md')));
  store.ensureDir(RUNTIME_DIR);
  const file = path.join(RUNTIME_DIR, `${agent.id}.${mode}.md`);
  const text = parts.join('\n');
  if (readText(file) !== text.trim()) fs.writeFileSync(file, text);
  return file;
}

function buildContext(agent, config, mode = 'work') {
  const agents = listAgents();
  const roleCfg = config.roles[agent.role] || {};
  const lines = [`## Team roster`, teamRoster(agents)];
  if (mode === 'work') {
    const assignable = agents.filter(a => (roleCfg.canAssignTo || []).includes(a.role)).map(a => a.id);
    lines.push(`You may hand off work only to these agent ids: ${assignable.join(', ') || '(none)'}.`);
    const memory = readMemory(agent.id);
    const memoryTail = memory.length > config.memoryMaxChars ? memory.slice(-config.memoryMaxChars) : memory;
    const worklog = readWorklog(agent.id, config.worklogEntriesInPrompt * 3)
      .filter(w => w.kind !== 'comment')
      .slice(-config.worklogEntriesInPrompt)
      .map(w => `- ${w.ts.slice(0, 16)} [${w.project}] ${w.task} => ${w.status}: ${w.summary}`)
      .join('\n');
    lines.push('', '## Long-term memory', memoryTail || '(empty)', '', '## Your recent work log', worklog || '(empty)');
  }
  return lines.join('\n');
}

function createAgent(role, config, reason) {
  const agents = listAgents();
  const sameRole = agents.filter(a => a.role === role);
  const template = sameRole[0];
  if (!template) throw new Error(`No existing agent with role ${role} to clone`);
  let n = sameRole.length + 1;
  while (fs.existsSync(agentDir(`${role}-${n}`))) n++;
  const id = `${role}-${n}`;
  const used = new Set(agents.map(a => a.name));
  const pool = (config.namePool && config.namePool[role]) || [];
  const name = pool.find(x => !used.has(x)) || `${template.name}${n}`;
  const profile = {
    ...template,
    id,
    name,
    aliases: [],
    color: COLORS[agents.length % COLORS.length],
    createdAt: new Date().toISOString(),
    createdReason: reason || ''
  };
  const dir = agentDir(id);
  store.ensureDir(path.join(dir, 'skills'));
  store.writeJson(path.join(dir, 'profile.json'), profile);
  fs.writeFileSync(path.join(dir, 'RULES.md'), '');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '');
  fs.writeFileSync(path.join(dir, 'skills', '.gitkeep'), '');
  return profile;
}

function agentDetails(id) {
  const agent = getAgent(id);
  if (!agent) return null;
  return {
    profile: agent,
    rules: readText(path.join(agentDir(id), 'RULES.md')),
    memory: readMemory(id),
    skills: listSkills(agent).map(s => ({ name: s.name, description: s.description })),
    worklog: readWorklog(id, 60).filter(w => w.kind !== 'comment').slice(-20),
    usage: usageTotals(id)
  };
}

module.exports = {
  AGENTS_DIR,
  RUNTIME_DIR,
  TEAM_DIR,
  listAgents,
  getAgent,
  isRetired,
  matchesAgent,
  agentDir,
  roleDir,
  appendMemory,
  appendWorklog,
  getSession,
  setSession,
  clearSessions,
  buildSystemPrompt,
  buildContext,
  setMock,
  usageTotals,
  createAgent,
  agentDetails
};
