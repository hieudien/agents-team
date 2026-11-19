const EventEmitter = require('events');
const store = require('./store');
const agents = require('./agents');
const Prompts = require('./orch/prompts');
const Comments = require('./orch/comments');
const Runner = require('./orch/runner');
const Routing = require('./orch/routing');

const VISUAL_HINT = /giao diện|màn hình|trang web|trang chủ|landing|\bui\b|\bux\b|\bcss\b|button|nút |layout|responsive|trình duyệt|browser|screenshot|ảnh chụp|front-?end|html/i;

const TERMINAL = ['done', 'failed', 'blocked', 'cancelled', 'waiting', 'answered'];

class Orchestrator extends EventEmitter {
  constructor(config, { mock } = {}) {
    super();
    this.config = config;
    this.failStreak = new Map();
    this.limit = null;
    this.comments = { enabled: false, reviewOnTag: true, adversarialDiff: false, reviewRoles: ['manager', 'tester'], model: 'haiku', effort: null, maxConcurrent: 4, ...(config.comments || {}) };
    this.mock = !!mock;
    agents.setMock(this.mock);
    this.tasks = store.loadTasks().filter(t => t.conversationId);
    this.children = new Map();
    for (const t of this.tasks) if (t.status === 'running') t.status = 'queued';
    this.reassignRetired();
    this.save();
    setImmediate(() => this.pump());
  }

  save() {
    store.saveTasks(this.tasks);
  }

  reassignRetired() {
    const manager = agents.listAgents().find(a => a.role === 'manager');
    for (const t of this.tasks) {
      if (!['queued', 'waiting'].includes(t.status) || !agents.isRetired(t.to)) continue;
      if (t.kind === 'comment' || !manager) t.status = 'cancelled';
      else t.to = manager.id;
    }
  }

  post(projectId, conversationId, message) {
    const entry = store.addChat(projectId, conversationId, message);
    this.emit('event', { type: 'chat', projectId, conversationId, message: entry });
    if (entry.type !== 'system') this.emitConversations(projectId);
    return entry;
  }

  emitConversations(projectId) {
    this.emit('event', { type: 'conversations', projectId, conversations: this.conversationStates(projectId) });
  }

  conversationStates(projectId) {
    return store.listConversations(projectId).map(c => ({
      ...c,
      active: this.tasks.some(t => t.conversationId === c.id && ['queued', 'running'].includes(t.status))
    }));
  }

  toast(message, level = 'error', key) {
    this.recentToasts = this.recentToasts || new Map();
    const k = key || message;
    const last = this.recentToasts.get(k);
    if (last && Date.now() - last < 10000) return;
    this.recentToasts.set(k, Date.now());
    console[level === 'error' ? 'error' : 'log'](`[${level}] ${message}`);
    this.emit('event', { type: 'toast', level, message: String(message).slice(0, 500) });
  }

  emitAgents() {
    this.emit('event', { type: 'agents', agents: this.agentStates() });
  }

  agentStates() {
    return agents.listAgents().map(a => {
      const mine = this.tasks.filter(t => t.to === a.id);
      const work = mine.filter(t => t.kind !== 'comment');
      const running = work.find(t => t.status === 'running');
      const commenting = mine.some(t => t.kind === 'comment' && t.status === 'running');
      return {
        ...a,
        state: running ? 'working' : commenting ? 'commenting' : 'idle',
        currentTask: running ? running.title : null,
        queue: work.filter(t => t.status === 'queued').length
      };
    });
  }

  workloadText() {
    return this.agentStates()
      .map(a => `- ${a.id} ${a.name} (${a.role}): ${a.state === 'working' ? 'working' : 'idle'}${a.currentTask ? ` on "${a.currentTask}"` : ''}, queued ${a.queue}`)
      .join('\n');
  }

  parseMentions(text) {
    const all = agents.listAgents();
    const found = [];
    for (const m of String(text).matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
      const agent = all.find(a => agents.matchesAgent(a, m[1]));
      if (agent && !found.includes(agent)) found.push(agent);
    }
    return found;
  }

  handleUserMessage(projectId, conversationId, text, attachments = []) {
    this.clearLimit();
    const project = store.getProject(projectId);
    if (!project) throw new Error('Project not found');
    let conv = conversationId && store.getConversation(projectId, conversationId);
    if (!conv) conv = store.createConversation(projectId);
    if (conv.autoTitle) store.updateConversation(projectId, conv.id, { title: text.replace(/\s+/g, ' ').slice(0, 50), autoTitle: false });

    const directAgent = conv.directAgentId ? agents.getAgent(conv.directAgentId) : null;
    if (conv.directAgentId && (!directAgent || directAgent.retired)) throw new Error('Agent của cuộc trò chuyện này không còn trong team');
    const mentioned = directAgent ? [directAgent] : this.parseMentions(text);
    this.post(projectId, conv.id, { type: 'user', from: 'user', text, data: { mentions: mentioned.map(a => a.id), attachments: attachments.map(({ name, file, url }) => ({ name, file, url })) } });
    const resumed = mentioned.length ? [] : this.resumeWaiting(conv.id, text, attachments);
    for (const t of this.tasks) {
      if (t.conversationId === conv.id && t.status === 'waiting') t.status = 'answered';
    }
    if (resumed.length) {
      this.save();
      this.emitConversations(projectId);
      this.pump();
      return conv;
    }

    const base = { projectId, conversationId: conv.id, rootId: store.newId('r'), from: 'user', task: text, checklist: [], attachments };
    if (mentioned.length) {
      for (const agent of mentioned) {
        this.enqueue({ ...base, to: agent.id, title: 'Yêu cầu trực tiếp từ người dùng', reviewAfter: !directAgent, taggedIds: mentioned.map(a => a.id), needsBrowser: this.looksVisual(text, attachments) });
      }
      return conv;
    }

    const all = agents.listAgents();
    const manager = all.find(a => a.role === 'manager');
    if (!manager) throw new Error('No manager agent');
    const waitFor = [];
    if (this.comments.enabled) {
      for (const agent of all.filter(a => a.id !== manager.id && this.comments.reviewRoles.includes(a.role))) {
        waitFor.push(this.enqueue({ ...base, kind: 'comment', commentMode: 'open', to: agent.id, title: 'Góp ý' }, true).id);
      }
    }
    this.enqueue({ ...base, to: manager.id, title: 'Yêu cầu từ người dùng', waitFor });
    return conv;
  }

  looksVisual(text, attachments) {
    return (attachments || []).length > 0 || VISUAL_HINT.test(String(text));
  }

  asksUser(task) {
    const agent = agents.getAgent(task.to);
    return task.from === 'user' || (!!agent && agent.role === 'manager');
  }

  resumeWaiting(conversationId, text, attachments) {
    const waiting = new Map(this.tasks.filter(t => t.conversationId === conversationId && t.status === 'waiting').map(t => [t.id, t]));
    const origins = new Set();
    for (const t of waiting.values()) {
      if (!this.asksUser(t)) continue;
      let origin = t;
      while (waiting.has(origin.parentId)) origin = waiting.get(origin.parentId);
      origins.add(origin);
    }
    const now = new Date().toISOString();
    for (const t of origins) {
      Object.assign(t, {
        status: 'queued',
        userAnswers: [...(t.userAnswers || []), text],
        attachments: [...(t.attachments || []), ...attachments],
        updatedAt: now
      });
    }
    return [...origins];
  }

  enqueue(spec, deferPump) {
    const now = new Date().toISOString();
    const task = { id: store.newId('t'), kind: 'work', status: 'queued', attempts: 0, createdAt: now, updatedAt: now, ...spec };
    this.tasks.push(task);
    this.save();
    if (!deferPump) {
      this.emitAgents();
      this.pump();
    }
    return task;
  }

  isReady(task) {
    if (task.status !== 'queued') return false;
    return (task.waitFor || []).every(id => {
      const dep = this.tasks.find(t => t.id === id);
      return !dep || TERMINAL.includes(dep.status);
    });
  }

  limited() {
    return !!this.limit && Date.now() < this.limit.until;
  }

  pauseForLimit(message, projectId, conversationId) {
    const minutes = this.config.limitPauseMinutes || 15;
    this.limit = { until: Date.now() + minutes * 60000, message };
    clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => {
      this.limit = null;
      this.pump();
    }, minutes * 60000);
    if (this.limitTimer.unref) this.limitTimer.unref();
    this.toast(`Hết quota Claude: ${message}`, 'error', 'usage-limit');
    if (projectId && conversationId) {
      this.post(projectId, conversationId, { type: 'system', from: 'system', text: `Hết quota Claude (${String(message).slice(0, 160)}). Tạm dừng ${minutes} phút, gửi tin mới để thử lại ngay.` });
    }
  }

  clearLimit() {
    this.limit = null;
    clearTimeout(this.limitTimer);
  }

  pump() {
    if (this.limited()) return this.emitAgents();
    const running = this.tasks.filter(t => t.status === 'running');
    const busy = new Set(running.filter(t => t.kind !== 'comment').map(t => t.to));
    let workCount = busy.size;
    let commentCount = running.filter(t => t.kind === 'comment').length;
    for (const task of this.tasks) {
      if (!this.isReady(task)) continue;
      if (task.kind === 'comment') {
        if (commentCount >= this.comments.maxConcurrent) continue;
        commentCount++;
        this.runComment(task);
        continue;
      }
      if (workCount >= this.config.maxConcurrentRuns || busy.has(task.to)) continue;
      busy.add(task.to);
      workCount++;
      this.run(task);
    }
    this.emitAgents();
  }

  update(task, patch) {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.save();
    this.emitAgents();
    if (['running', 'done', 'failed', 'blocked', 'cancelled', 'waiting'].includes(patch.status)) this.emitConversations(task.projectId);
  }

  stopAll() {
    this.clearLimit();
    const projects = new Set();
    for (const t of this.tasks) {
      if (['queued', 'running'].includes(t.status)) {
        t.status = 'cancelled';
        projects.add(t.projectId);
      }
    }
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    this.save();
    this.emitAgents();
    for (const p of projects) this.emitConversations(p);
  }

  createAgent(role, reason, projectId, conversationId) {
    const profile = agents.createAgent(role, this.config, reason);
    if (projectId && conversationId) {
      this.post(projectId, conversationId, { type: 'system', from: profile.id, text: `Chào cả team, tôi là ${profile.name} (${profile.title}), hãy tag tôi bằng @${profile.name} nhé!` });
    }
    this.emitAgents();
    this.pump();
    return profile;
  }
}

for (const Part of [Prompts, Comments, Runner, Routing]) {
  for (const name of Object.getOwnPropertyNames(Part.prototype)) {
    if (name !== 'constructor') Orchestrator.prototype[name] = Part.prototype[name];
  }
}

module.exports = Orchestrator;