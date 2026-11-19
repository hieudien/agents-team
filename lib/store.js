const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

function readJsonlTail(file, limit) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const slice = limit ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function newId(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex');
}

const projectsFile = path.join(DATA, 'projects.json');
const tasksFile = path.join(DATA, 'tasks.json');

function listProjects() {
  return readJson(projectsFile, []);
}

function getProject(id) {
  return listProjects().find(p => p.id === id) || null;
}

function createProject({ name, workspace }) {
  const projects = listProjects();
  const project = {
    id: newId('p'),
    name: String(name || 'Untitled').slice(0, 80),
    workspace: path.resolve(workspace),
    createdAt: new Date().toISOString()
  };
  ensureDir(project.workspace);
  projects.push(project);
  writeJson(projectsFile, projects);
  return project;
}

function projectDir(projectId) {
  return path.join(DATA, 'projects', projectId);
}

function conversationsFile(projectId) {
  return path.join(projectDir(projectId), 'conversations.json');
}

function chatFile(projectId, conversationId) {
  return path.join(projectDir(projectId), 'conversations', conversationId + '.jsonl');
}

function listConversations(projectId) {
  const file = conversationsFile(projectId);
  let list = readJson(file, null);
  if (!list) {
    list = [];
    const legacy = path.join(projectDir(projectId), 'chat.jsonl');
    if (fs.existsSync(legacy)) {
      const conv = { id: newId('c'), title: 'Cuộc trò chuyện 1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastText: '' };
      ensureDir(path.dirname(chatFile(projectId, conv.id)));
      fs.renameSync(legacy, chatFile(projectId, conv.id));
      list.push(conv);
      writeJson(file, list);
    }
  }
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getConversation(projectId, conversationId) {
  return listConversations(projectId).find(c => c.id === conversationId) || null;
}

function createConversation(projectId, title) {
  const list = listConversations(projectId);
  const now = new Date().toISOString();
  const conv = { id: newId('c'), title: String(title || '').slice(0, 60) || 'Cuộc trò chuyện mới', autoTitle: !title, createdAt: now, updatedAt: now, lastText: '' };
  list.push(conv);
  writeJson(conversationsFile(projectId), list);
  return conv;
}

function updateConversation(projectId, conversationId, patch) {
  const list = listConversations(projectId);
  const conv = list.find(c => c.id === conversationId);
  if (!conv) return null;
  Object.assign(conv, patch);
  writeJson(conversationsFile(projectId), list);
  return conv;
}

function addChat(projectId, conversationId, message) {
  const entry = { id: newId('m'), ts: new Date().toISOString(), ...message };
  appendJsonl(chatFile(projectId, conversationId), entry);
  if (entry.type !== 'system') {
    updateConversation(projectId, conversationId, { updatedAt: entry.ts, lastText: String(entry.text || '').slice(0, 80) });
  }
  return entry;
}

function readChat(projectId, conversationId, limit) {
  return readJsonlTail(chatFile(projectId, conversationId), limit);
}

function uploadsDir(projectId) {
  return path.join(projectDir(projectId), 'uploads');
}

const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function saveUpload(projectId, name, dataUrl) {
  if (!getProject(projectId)) throw new Error('Project not found');
  const m = String(dataUrl || '').match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m || !IMAGE_TYPES[m[1]]) throw new Error('Chỉ hỗ trợ ảnh PNG, JPG, GIF, WEBP');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) throw new Error('Ảnh lớn hơn 10MB');
  const file = newId('img') + IMAGE_TYPES[m[1]];
  const dir = uploadsDir(projectId);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, file), buf);
  return { name: String(name || file).slice(0, 80), file, path: path.join(dir, file), url: `/uploads/${projectId}/${file}` };
}

function resolveAttachments(projectId, list) {
  const dir = uploadsDir(projectId);
  return (Array.isArray(list) ? list : [])
    .slice(0, 10)
    .map(a => {
      const file = path.basename(String(a.file || ''));
      const full = path.join(dir, file);
      return file && fs.existsSync(full) ? { name: String(a.name || file).slice(0, 80), file, path: full, url: `/uploads/${projectId}/${file}` } : null;
    })
    .filter(Boolean);
}

function loadTasks() {
  return readJson(tasksFile, []);
}

function saveTasks(tasks) {
  const keep = tasks.filter(t => ['queued', 'running', 'waiting'].includes(t.status) || Date.now() - Date.parse(t.updatedAt || t.createdAt) < 7 * 864e5);
  writeJson(tasksFile, keep);
}

module.exports = {
  ROOT,
  DATA,
  ensureDir,
  readJson,
  writeJson,
  appendJsonl,
  readJsonlTail,
  newId,
  listProjects,
  getProject,
  createProject,
  uploadsDir,
  saveUpload,
  resolveAttachments,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  addChat,
  readChat,
  loadTasks,
  saveTasks
};
