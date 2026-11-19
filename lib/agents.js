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
    .filter(Boolean)
    .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.id.localeCompare(b.id));
}

function roleOrder(role) {
  return { manager: 0, coordinator: 1, dev: 2, tester: 3 }[role] ?? 9;
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

function appendMemory(id, items) {
  const clean = (items || []).map(s => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 5);
  if (!clean.length) return [];
  const file = path.join(agentDir(id), 'MEMORY.md');
  const existing = readText(file);
  const day = new Date().toISOString().slice(0, 10);
  const fresh = clean.filter(s => !existing.includes(s));
  if (!fresh.length) return [];
  fs.appendFileSync(file, (existing ? '\n' : '') + fresh.map(s => `- ${day}: ${s}`).join('\n') + '\n');
  return fresh;
}

function appendWorklog(id, entry) {
  store.appendJsonl(path.join(agentDir(id), 'worklog.jsonl'), { ts: new Date().toISOString(), ...entry });
}

function readWorklog(id, limit) {
  return store.readJsonlTail(path.join(agentDir(id), 'worklog.jsonl'), limit);
}

function sessionsFile(id) {
  return path.join(agentDir(id), 'sessions.json');
}

function getSession(id, projectId) {
  return store.readJson(sessionsFile(id), {})[projectId] || null;
}

function setSession(id, projectId, sessionId) {
  const all = store.readJson(sessionsFile(id), {});
  if (sessionId) all[projectId] = sessionId;
  else delete all[projectId];
  store.writeJson(sessionsFile(id), all);
}

function teamRoster(agents) {
  return agents.map(a => `- ${a.id}: ${a.name}, ${a.title} (role: ${a.role})`).join('\n');
}

function buildSystemPrompt(agent, config, mode = 'work') {
  const agents = listAgents();
  const roleCfg = config.roles[agent.role] || {};
  const memory = readMemory(agent.id);
  const memoryTail = memory.length > config.memoryMaxChars ? memory.slice(-config.memoryMaxChars) : memory;
  const worklog = readWorklog(agent.id, config.worklogEntriesInPrompt)
    .map(w => `- ${w.ts.slice(0, 16)} [${w.project}] ${w.task} => ${w.status}: ${w.summary}`)
    .join('\n');
  const skills = listSkills(agent)
    .map(s => `- ${s.name}: ${s.description} (file: ${s.file})`)
    .join('\n');
  const assignable = agents.filter(a => (roleCfg.canAssignTo || []).includes(a.role)).map(a => a.id);

  const parts = [
    `# Identity`,
    `You are ${agent.name} (agent id: ${agent.id}), ${agent.title} in a software development team.`,
    `Bio: ${agent.bio}`,
    `Personality: ${agent.personality}`,
    ``,
    `# Team roster`,
    teamRoster(agents),
    ``,
    `You may hand off work only to these agent ids: ${assignable.join(', ') || '(none)'}.`,
    ``,
    `# Global team rules`,
    readText(path.join(TEAM_DIR, 'RULES.md')),
    ``,
    `# Role rules (${agent.role})`,
    readText(path.join(roleDir(agent.role), 'RULES.md')),
    ``,
    `# Personal rules`,
    readText(path.join(agentDir(agent.id), 'RULES.md')) || '(none)',
    ``,
    `# Skills`,
    `Read a skill file with the Read tool before doing work it covers.`,
    skills || '(none)',
    ``,
    `# Long-term memory`,
    memoryTail || '(empty)',
    ``,
    `# Your recent work log`,
    worklog || '(empty)',
    ``,
    `# Output contract`,
    readText(path.join(TEAM_DIR, mode === 'comment' ? 'COMMENT.md' : 'OUTPUT.md'))
  ];
  store.ensureDir(RUNTIME_DIR);
  const file = path.join(RUNTIME_DIR, `${agent.id}.${mode}.md`);
  fs.writeFileSync(file, parts.join('\n'));
  return file;
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
    worklog: readWorklog(id, 20)
  };
}

module.exports = {
  AGENTS_DIR,
  RUNTIME_DIR,
  TEAM_DIR,
  listAgents,
  getAgent,
  agentDir,
  roleDir,
  appendMemory,
  appendWorklog,
  getSession,
  setSession,
  buildSystemPrompt,
  createAgent,
  agentDetails
};
