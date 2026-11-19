const EventEmitter = require('events');
const store = require('./store');
const agents = require('./agents');
const claude = require('./claude');

const TERMINAL = ['done', 'failed', 'blocked', 'cancelled', 'waiting', 'answered'];

class Orchestrator extends EventEmitter {
  constructor(config, { mock } = {}) {
    super();
    this.config = config;
    this.comments = { enabled: true, model: 'haiku', effort: 'low', maxConcurrent: 4, ...(config.comments || {}) };
    this.mock = !!mock;
    this.tasks = store.loadTasks().filter(t => t.conversationId);
    this.children = new Map();
    for (const t of this.tasks) if (t.status === 'running') t.status = 'queued';
    this.save();
    setImmediate(() => this.pump());
  }

  save() {
    store.saveTasks(this.tasks);
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
      const key = m[1].toLowerCase();
      const agent = all.find(a => a.name.toLowerCase() === key || a.id.toLowerCase() === key);
      if (agent && !found.includes(agent)) found.push(agent);
    }
    return found;
  }

  handleUserMessage(projectId, conversationId, text, attachments = []) {
    const project = store.getProject(projectId);
    if (!project) throw new Error('Project not found');
    let conv = conversationId && store.getConversation(projectId, conversationId);
    if (!conv) conv = store.createConversation(projectId);
    if (conv.autoTitle) store.updateConversation(projectId, conv.id, { title: text.replace(/\s+/g, ' ').slice(0, 50), autoTitle: false });

    const mentioned = this.parseMentions(text);
    this.post(projectId, conv.id, { type: 'user', from: 'user', text, data: { mentions: mentioned.map(a => a.id), attachments: attachments.map(({ name, file, url }) => ({ name, file, url })) } });
    for (const t of this.tasks) {
      if (t.conversationId === conv.id && t.status === 'waiting') t.status = 'answered';
    }

    const base = { projectId, conversationId: conv.id, rootId: store.newId('r'), from: 'user', task: text, checklist: [], attachments };
    if (mentioned.length) {
      for (const agent of mentioned) {
        this.enqueue({ ...base, to: agent.id, title: 'Yêu cầu trực tiếp từ người dùng', reviewAfter: true, taggedIds: mentioned.map(a => a.id) });
      }
      return conv;
    }

    const all = agents.listAgents();
    const manager = all.find(a => a.role === 'manager');
    if (!manager) throw new Error('No manager agent');
    const waitFor = [];
    if (this.comments.enabled) {
      for (const agent of all.filter(a => a.id !== manager.id)) {
        waitFor.push(this.enqueue({ ...base, kind: 'comment', commentMode: 'open', to: agent.id, title: 'Góp ý' }, true).id);
      }
    }
    this.enqueue({ ...base, to: manager.id, title: 'Yêu cầu từ người dùng', waitFor });
    return conv;
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

  pump() {
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

  nameOf(id) {
    if (id === 'user') return 'User';
    const a = agents.getAgent(id);
    return a ? a.name : id;
  }

  recentChat(task) {
    return store
      .readChat(task.projectId, task.conversationId, this.config.recentChatForPrompt)
      .map(m => `[${m.ts.slice(11, 16)}] ${this.nameOf(m.from)}${m.to ? ' -> ' + this.nameOf(m.to) : ''}: ${m.text}`)
      .join('\n');
  }

  attachmentLines(task) {
    const list = task.attachments || [];
    if (!list.length) return [];
    return ['', '## Images attached by the user (open them with the Read tool before answering)', ...list.map(a => `- ${a.path} (${a.name})`)];
  }

  extraDirs(agent, task) {
    const dirs = [agents.agentDir(agent.id), agents.roleDir(agent.role)];
    if ((task.attachments || []).length) dirs.push(store.uploadsDir(task.projectId));
    return dirs;
  }

  isWorker(agent) {
    return ['dev', 'tester'].includes(agent.role);
  }

  buildPrompt(task, agent, project) {
    const lines = [
      `# Task ${task.id}: ${task.title}`,
      `From: ${this.nameOf(task.from)} (${task.from})`,
      `Project: ${project.name}`,
      `Workspace (your current directory): ${project.workspace}`
    ];
    if (task.from === 'user' && task.taggedIds) lines.push(`The user tagged you directly. Answer or do the work yourself if it fits your role; otherwise explain and hand off as allowed.`);
    lines.push(
      ``,
      `## Task`,
      task.task,
      ...this.attachmentLines(task),
      ``,
      this.isWorker(agent) ? `## Required checklist (copy each item exactly into your checklist)` : `## Acceptance criteria of the goal (pass them on to the workers, do not verify them yourself)`,
      task.checklist && task.checklist.length ? task.checklist.map(c => `- ${c}`).join('\n') : 'None given. Define your own checklist for this task.'
    );
    if (task.gateFeedback) lines.push('', '## Feedback from the previous attempt', task.gateFeedback);
    if (['manager', 'coordinator'].includes(agent.role)) lines.push('', '## Team workload now', this.workloadText());
    lines.push('', '## Recent team chat', this.recentChat(task) || '(empty)', '', 'Do the task now, then answer with the JSON object.');
    return lines.join('\n');
  }

  buildCommentPrompt(task, project) {
    const lines = [
      task.commentMode === 'review' ? '# Review' : '# Open discussion',
      `Project: ${project.name}`,
      `Workspace: ${project.workspace}`,
      '',
      '## User message',
      task.task,
      ...this.attachmentLines(task)
    ];
    if (task.commentMode === 'review' && task.reviewOf) {
      const r = task.reviewOf;
      lines.push('', `## Answer from ${this.nameOf(r.agentId)} (${r.agentId}), the tagged teammate`, `Status: ${r.status}`, `Chat: ${r.chat}`);
      if (r.report) lines.push(`Report to user: ${r.report}`);
      if (r.handoffs.length) lines.push('Handoffs:', ...r.handoffs.map(h => `- to ${h.to}: ${h.title} | ${h.task}`));
      if (r.checklist.length) lines.push('Checklist:', ...r.checklist.map(c => `- [${c.pass ? 'x' : ' '}] ${c.item} (${c.evidence})`));
    }
    lines.push('', '## Recent team chat', this.recentChat(task) || '(empty)', '', 'Answer with the JSON object.');
    return lines.join('\n');
  }

  async runComment(task) {
    try {
      await this.runCommentInner(task);
    } catch (e) {
      this.crash(task, e);
    }
  }

  async runCommentInner(task) {
    const agent = agents.getAgent(task.to);
    const project = store.getProject(task.projectId);
    if (!agent || !project) return this.update(task, { status: 'failed' });
    this.update(task, { status: 'running' });
    const roleCfg = { model: this.comments.model, effort: this.comments.effort, tools: 'Read,Glob,Grep', allowedTools: ['Read', 'Glob', 'Grep'], permissionMode: 'default', browser: false };
    const result = await claude.runClaude({
      config: this.config,
      mock: this.mock,
      mode: 'comment',
      agent,
      roleCfg,
      systemFile: agents.buildSystemPrompt(agent, this.config, 'comment'),
      prompt: this.buildCommentPrompt(task, project),
      cwd: project.workspace,
      extraDirs: this.extraDirs(agent, task),
      onSpawn: child => this.children.set(task.id, child)
    });
    this.children.delete(task.id);
    if (task.status === 'cancelled') return this.pump();
    if (!result.ok) {
      this.toast(`${agent.name} không góp ý được: ${result.error}`, 'error', result.error);
      this.update(task, { status: 'failed', error: result.error });
      return this.pump();
    }
    const out = result.output;
    if (out.speak && String(out.chat || '').trim()) {
      this.post(project.id, task.conversationId, {
        type: 'agent',
        from: agent.id,
        text: this.sanitizeChat(out.chat),
        data: { kind: task.commentMode === 'review' ? 'review' : 'comment' }
      });
    }
    this.update(task, { status: 'done' });
    this.pump();
  }

  async run(task) {
    try {
      await this.runInner(task);
    } catch (e) {
      this.crash(task, e);
    }
  }

  crash(task, e) {
    this.children.delete(task.id);
    this.toast(`Lỗi khi xử lý task "${task.title}" (${task.to}): ${e.message}`);
    if (task.status === 'running') this.update(task, { status: 'failed', error: e.message });
    this.pump();
  }

  async runInner(task) {
    const agent = agents.getAgent(task.to);
    const project = store.getProject(task.projectId);
    if (!agent || !project) return this.update(task, { status: 'failed', error: 'agent or project missing' });
    const roleCfg = this.config.roles[agent.role] || {};
    this.update(task, { status: 'running', startedAt: new Date().toISOString() });

    const attemptRun = resume =>
      claude.runClaude({
        config: this.config,
        mock: this.mock,
        agent,
        roleCfg,
        systemFile: agents.buildSystemPrompt(agent, this.config),
        prompt: this.buildPrompt(task, agent, project),
        cwd: project.workspace,
        sessionId: resume || claude.newSessionId(),
        resume: !!resume,
        extraDirs: this.extraDirs(agent, task),
        onSpawn: child => this.children.set(task.id, child)
      });

    const saved = agents.getSession(agent.id, project.id);
    let result = await attemptRun(saved);
    if (!result.ok && saved && task.status !== 'cancelled' && /no conversation|not found|session/i.test(result.error || '')) {
      agents.setSession(agent.id, project.id, null);
      result = await attemptRun(null);
    }
    this.children.delete(task.id);
    if (task.status === 'cancelled') return this.pump();

    if (!result.ok) {
      task.attempts++;
      this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name} gặp lỗi khi chạy CLI: ${result.error}` });
      this.toast(`${agent.name}: ${result.error}`, 'error', result.error);
      this.update(task, { status: task.attempts < 2 ? 'queued' : 'failed', error: result.error });
      return this.pump();
    }

    agents.setSession(agent.id, project.id, result.sessionId);
    this.process(task, agent, project, result);
    this.pump();
  }

  sanitizeChat(text) {
    let t = String(text || '').replace(/```[\s\S]*?```/g, '[code đã ẩn]').replace(/\s+/g, ' ').trim();
    if (t.length > this.config.chatMaxChars) t = t.slice(0, this.config.chatMaxChars - 1) + '…';
    return t;
  }

  checkGate(task, agent, out) {
    const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const list = Array.isArray(out.checklist) ? out.checklist : [];
    const problems = [];
    if (!list.length) problems.push('Checklist is empty.');
    for (const c of list) if (!c.pass) problems.push(`Failed: ${c.item}`);
    for (const req of this.isWorker(agent) ? task.checklist || [] : []) {
      const key = norm(req).slice(0, 60);
      if (!list.some(c => norm(c.item).includes(key))) problems.push(`Missing required item: ${req}`);
    }
    return problems;
  }

  process(task, agent, project, result) {
    const out = result.output;
    const conv = task.conversationId;
    const checklist = Array.isArray(out.checklist) ? out.checklist : [];
    const passed = checklist.filter(c => c.pass).length;
    this.post(project.id, conv, {
      type: 'agent',
      from: agent.id,
      text: this.sanitizeChat(out.chat),
      data: { status: out.status, checklist, taskTitle: task.title, durationMs: result.durationMs }
    });

    const remembered = agents.appendMemory(agent.id, out.memory_add);
    agents.appendWorklog(agent.id, {
      project: project.name,
      taskId: task.id,
      task: task.title,
      status: out.status,
      checklist: `${passed}/${checklist.length}`,
      summary: this.sanitizeChat(out.chat).slice(0, 200),
      remembered
    });

    if (out.status === 'done') {
      const problems = this.checkGate(task, agent, out);
      if (problems.length) {
        this.gateFail(task, agent, project, problems);
      } else {
        this.update(task, { status: 'done', gateFeedback: null });
        this.dispatch(task, agent, project, out);
      }
    } else if (out.status === 'need_info' && (agent.role === 'manager' || task.from === 'user')) {
      this.update(task, { status: 'waiting' });
      for (const q of out.questions_to_user || []) this.post(project.id, conv, { type: 'question', from: agent.id, text: q });
    } else {
      this.update(task, { status: out.status === 'need_info' ? 'waiting' : 'blocked' });
      this.escalate(task, agent, project, out.status === 'need_info' ? 'Cần thêm thông tin' : 'Bị chặn', this.sanitizeChat(out.chat));
    }

    if (out.report_to_user && (agent.role === 'manager' || task.from === 'user')) this.post(project.id, conv, { type: 'report', from: agent.id, text: out.report_to_user });
    if (out.propose_agent && agent.role === 'coordinator') {
      this.post(project.id, conv, { type: 'proposal', from: agent.id, text: out.propose_agent.reason, data: { role: out.propose_agent.role } });
    }
    if (task.reviewAfter && task.status !== 'queued') this.enqueueReviews(task, agent, out);
  }

  enqueueReviews(task, agent, out) {
    if (!this.comments.enabled) return;
    const reviewOf = {
      agentId: agent.id,
      status: out.status,
      chat: this.sanitizeChat(out.chat),
      report: out.report_to_user || '',
      handoffs: (out.handoffs || []).map(h => ({ to: h.to, title: h.title, task: String(h.task).slice(0, 600) })),
      checklist: (out.checklist || []).slice(0, 15)
    };
    const reviewers = agents.listAgents().filter(a => !(task.taggedIds || []).includes(a.id));
    for (const r of reviewers) {
      this.enqueue(
        {
          kind: 'comment',
          commentMode: 'review',
          projectId: task.projectId,
          conversationId: task.conversationId,
          rootId: task.rootId,
          from: 'user',
          to: r.id,
          title: `Phản biện ${agent.name}`,
          task: task.task,
          checklist: [],
          attachments: task.attachments || [],
          reviewOf
        },
        true
      );
    }
    this.pump();
  }

  gateFail(task, agent, project, problems) {
    task.attempts++;
    const feedback = problems.join('\n');
    if (task.attempts <= this.config.maxGateRetries) {
      this.post(project.id, task.conversationId, {
        type: 'system',
        from: agent.id,
        text: `Checklist của ${agent.name} chưa đạt (${problems.length} vấn đề), làm lại lần ${task.attempts}.`,
        data: { problems }
      });
      this.update(task, { status: 'queued', gateFeedback: feedback });
    } else {
      this.update(task, { status: 'blocked', gateFeedback: feedback });
      this.escalate(task, agent, project, 'Checklist không đạt sau nhiều lần', feedback);
    }
  }

  child(task, spec) {
    return { projectId: task.projectId, conversationId: task.conversationId, rootId: task.rootId, parentId: task.id, attachments: task.attachments || [], ...spec };
  }

  escalate(task, agent, project, reason, detail) {
    const all = agents.listAgents();
    const targetRole = agent.role === 'coordinator' ? 'manager' : agent.role === 'manager' ? null : 'coordinator';
    const target = targetRole && all.find(a => a.role === targetRole);
    if (!target || !this.withinBudget(task)) {
      this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name}: ${reason}. Cần người dùng xử lý.` });
      return;
    }
    this.post(project.id, task.conversationId, { type: 'handoff', from: agent.id, to: target.id, text: `${reason}: ${task.title}` });
    this.enqueue(
      this.child(task, {
        from: agent.id,
        to: target.id,
        title: `${reason}: ${task.title}`.slice(0, 80),
        task: `${agent.name} (${agent.id}) reports "${reason}" on task "${task.title}".\nOriginal task: ${task.task}\nDetail: ${detail}`,
        checklist: []
      })
    );
  }

  withinBudget(task) {
    return this.tasks.filter(t => t.rootId === task.rootId && t.kind !== 'comment').length < this.config.maxTasksPerRequest;
  }

  resolveTarget(to, agent) {
    const all = agents.listAgents();
    const roleCfg = this.config.roles[agent.role] || {};
    const key = String(to).replace(/^@/, '').toLowerCase();
    let target = all.find(a => a.id === key || a.name.toLowerCase() === key);
    if (!target) {
      const sameRole = this.agentStates().filter(a => a.role === key);
      if (sameRole.length) {
        sameRole.sort((a, b) => a.queue + (a.state === 'working') - (b.queue + (b.state === 'working')));
        target = all.find(a => a.id === sameRole[0].id);
      }
    }
    if (!target || !(roleCfg.canAssignTo || []).includes(target.role)) return null;
    return target;
  }

  dispatch(task, agent, project, out) {
    for (const h of out.handoffs || []) {
      const target = this.resolveTarget(h.to, agent);
      if (!target) {
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name} không được giao việc cho "${h.to}", bỏ qua.` });
        continue;
      }
      if (!this.withinBudget(task)) {
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `Đã chạm giới hạn ${this.config.maxTasksPerRequest} task cho yêu cầu này, dừng giao việc.` });
        return;
      }
      this.post(project.id, task.conversationId, {
        type: 'handoff',
        from: agent.id,
        to: target.id,
        text: h.title,
        data: { task: h.task, checklist: h.checklist || [] }
      });
      this.enqueue(
        this.child(task, {
          from: agent.id,
          to: target.id,
          title: String(h.title || 'Task').slice(0, 80),
          task: h.task,
          checklist: h.checklist || []
        })
      );
    }
  }

  stopAll() {
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
      this.post(projectId, conversationId, { type: 'system', from: profile.id, text: `Hi team, mình là ${profile.name} (${profile.title}), tag mình bằng @${profile.name} nhé!` });
    }
    this.emitAgents();
    this.pump();
    return profile;
  }
}

module.exports = Orchestrator;
