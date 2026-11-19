const store = require('../store');
const agents = require('../agents');
const claude = require('../claude');
const verify = require('../verify');

class Runner {
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
    if (!agent || agent.retired || !project) return this.update(task, { status: 'failed', error: 'agent or project missing' });
    const roleCfg = this.runConfig(agent, task);
    this.update(task, { status: 'running', startedAt: new Date().toISOString() });

    const attemptRun = resumeId =>
      claude.runClaude({
        config: this.config,
        mock: this.mock,
        agent,
        roleCfg,
        systemFile: agents.buildSystemPrompt(agent, this.config),
        prompt: this.buildPrompt(task, agent, project),
        cwd: project.workspace,
        sessionId: resumeId || claude.newSessionId(),
        resume: !!resumeId,
        extraDirs: this.extraDirs(agent, task, this.isLight(agent)),
        browser: this.browserFor(roleCfg, task),
        isCancelled: () => task.status === 'cancelled',
        onSpawn: child => this.children.set(task.id, child)
      });

    const resumable = !!roleCfg.resume;
    const resetAfter = Number(roleCfg.resetSessionAfterTasks) || 0;
    let saved = resumable ? agents.getSession(agent.id, project.id, task.conversationId) : null;
    if (saved && resetAfter && saved.tasks >= resetAfter) {
      agents.setSession(agent.id, project.id, task.conversationId, null);
      saved = null;
    }
    let result = await attemptRun(saved && saved.id);
    if (!result.ok && saved && task.status !== 'cancelled' && /no conversation found|session\b.*\b(?:not found|does not exist|already in use|invalid)|no such session/i.test(result.error || '')) {
      agents.setSession(agent.id, project.id, task.conversationId, null);
      saved = null;
      result = await attemptRun(null);
    }
    this.children.delete(task.id);
    if (task.status === 'cancelled') return this.pump();

    if (!result.ok) {
      if (result.kind === 'usage_limit') {
        this.update(task, { status: 'queued', error: result.error });
        this.pauseForLimit(result.error, project.id, task.conversationId);
        return this.pump();
      }
      task.attempts++;
      this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name} gặp lỗi khi chạy CLI: ${result.error}` });
      this.toast(`${agent.name}: ${result.error}`, 'error', result.error);
      const tripped = this.noteFailure(task, project);
      const retry = result.kind === 'other' && task.attempts < 2 && !tripped;
      this.update(task, { status: retry ? 'queued' : 'failed', error: result.error });
      return this.pump();
    }
    this.failStreak.delete(task.rootId);

    if (resumable) agents.setSession(agent.id, project.id, task.conversationId, result.sessionId, (saved ? saved.tasks : 0) + 1);
    this.process(task, agent, project, result);
    this.pump();
  }

  noteFailure(task, project) {
    const max = this.config.maxConsecutiveFailures || 5;
    const count = (this.failStreak.get(task.rootId) || 0) + 1;
    this.failStreak.set(task.rootId, count);
    if (count < max) return false;
    this.failStreak.delete(task.rootId);
    for (const t of this.tasks) {
      if (t.rootId === task.rootId && t.id !== task.id && ['queued', 'waiting'].includes(t.status)) t.status = 'cancelled';
    }
    this.post(project.id, task.conversationId, { type: 'system', from: 'system', text: `Đã dừng yêu cầu này sau ${count} lỗi CLI liên tiếp. Kiểm tra đăng nhập hoặc kết nối rồi gửi lại.` });
    this.save();
    this.emitConversations(project.id);
    return true;
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
      data: { status: out.status, checklist, taskTitle: task.title, durationMs: result.durationMs, usage: result.usage, costUsd: result.costUsd }
    });

    this.recordWork(task, agent, project, out, `${passed}/${checklist.length}`, result);

    let verifying = false;
    if (out.status === 'done') {
      const problems = this.checkGate(task, agent, out);
      const command = problems.length ? '' : this.verifyCommand(agent, project, out);
      if (problems.length) {
        this.gateFail(task, agent, project, problems);
      } else if (command) {
        verifying = true;
        this.verifyAndDispatch(task, agent, project, out, command);
      } else {
        this.recordLessons(task, agent, project, out);
        this.update(task, { status: 'done', gateFeedback: null });
        this.dispatch(task, agent, project, out);
      }
    } else if (out.status === 'need_info' && (agent.role === 'manager' || task.from === 'user')) {
      this.recordLessons(task, agent, project, out);
      this.update(task, { status: 'waiting' });
      for (const q of out.questions_to_user || []) this.post(project.id, conv, { type: 'question', from: agent.id, text: q });
    } else {
      this.recordLessons(task, agent, project, out);
      this.update(task, { status: out.status === 'need_info' ? 'waiting' : 'blocked' });
      this.escalate(task, agent, project, out.status === 'need_info' ? 'Cần thêm thông tin' : 'Bị chặn', this.sanitizeChat(out.chat));
    }

    if (out.report_to_user && (agent.role === 'manager' || task.from === 'user')) this.post(project.id, conv, { type: 'report', from: agent.id, text: out.report_to_user });
    if (out.propose_agent && agent.role === 'manager') {
      this.post(project.id, conv, { type: 'proposal', from: agent.id, text: out.propose_agent.reason, data: { role: out.propose_agent.role } });
    }
    if (task.reviewAfter && task.status !== 'queued' && !verifying) this.enqueueReviews(task, agent, out);
  }

  verifyCommand(agent, project, out) {
    if (agent.role !== 'dev' || !(out.handoffs || []).length || (this.config.verify || {}).enabled === false) return '';
    return verify.resolveCommand(project, this.mock, (this.config.verify || {}).autoDetect === true);
  }

  async verifyAndDispatch(task, agent, project, out, command) {
    try {
      const cfg = this.config.verify || {};
      const conv = task.conversationId;
      this.post(project.id, conv, { type: 'system', from: agent.id, text: `Server đang chạy kiểm tra sau khi ${agent.name} xong: ${command}` });
      const res = await verify.run(command, project.workspace, {
        timeoutMs: (Number(cfg.timeoutSeconds) || 120) * 1000,
        maxChars: Number(cfg.outputChars) || 2000,
        onSpawn: child => this.children.set(task.id, { kill: () => verify.killTree(child) })
      });
      this.children.delete(task.id);
      if (task.status === 'cancelled') return this.pump();
      if (!res.ok) {
        const reason = res.timedOut ? `timed out after ${res.seconds}s` : `exit code ${res.code}`;
        this.gateFail(task, agent, project, [`Server ran "${command}" in the workspace and it failed (${reason}). Fix it before handing off.\n${res.output}`], 'Kiểm tra tự động');
        if (task.reviewAfter && task.status !== 'queued') this.enqueueReviews(task, agent, out);
        return this.pump();
      }
      this.post(project.id, conv, { type: 'system', from: agent.id, text: `Kiểm tra tự động đạt: ${command} (${res.seconds}s)` });
      this.recordLessons(task, agent, project, out);
      this.update(task, { status: 'done', gateFeedback: null });
      const note = `Server ran "${command}" after the dev finished: passed in ${res.seconds}s.`;
      this.dispatch(task, agent, project, { ...out, handoffs: out.handoffs.map(h => ({ ...h, task: `${h.task}\n${note}` })) });
      if (task.reviewAfter) this.enqueueReviews(task, agent, out);
      this.pump();
    } catch (e) {
      this.crash(task, e);
    }
  }

  // Only called once an attempt is accepted, so retried attempts do not re-save or double-count lessons.
  recordLessons(task, agent, project, out) {
    if (this.isWorker(agent) && out.status === 'done' && typeof out.verify_notes === 'string' && out.verify_notes.trim()) store.saveVerify(project.id, out.verify_notes);
    if (!this.mock) {
      const maxLines = this.config.memoryMaxLines || 50;
      const memory = agents.appendMemory(agent.id, out.memory_add, maxLines);
      for (const text of memory.duplicates) {
        if (store.bumpLesson(agent.id, text) === 2) {
          this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name} lặp lại một bài học 2 lần: "${text.slice(0, 120)}". Cân nhắc đưa vào agents/${agent.id}/RULES.md để thành quy tắc.` });
        }
      }
      if (memory.rejected.length) {
        const text = `MEMORY.md of ${agent.name} (${agent.id}) reached the ${maxLines}-line limit and needs cleanup. ${memory.rejected.length} new lesson(s) were not saved.`;
        this.toast(text, 'error', `memory-full-${agent.id}`);
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text, data: { problems: memory.rejected } });
      }
    }
  }

  recordWork(task, agent, project, out, checklist, result) {
    agents.appendWorklog(agent.id, {
      project: project.name,
      taskId: task.id,
      task: task.title,
      status: out.status,
      checklist,
      summary: this.sanitizeChat(out.chat).slice(0, 200),
      usage: result.usage,
      costUsd: result.costUsd,
      durationMs: result.durationMs
    });
  }

  gateFail(task, agent, project, problems, label = 'Checklist') {
    task.gateAttempts = (task.gateAttempts || 0) + 1;
    const feedback = problems.join('\n');
    if (task.gateAttempts <= this.config.maxGateRetries) {
      this.post(project.id, task.conversationId, {
        type: 'system',
        from: agent.id,
        text: `${label} của ${agent.name} chưa đạt (${problems.length} vấn đề), làm lại lần ${task.gateAttempts}.`,
        data: { problems }
      });
      this.update(task, { status: 'queued', gateFeedback: feedback });
    } else {
      this.update(task, { status: 'blocked', gateFeedback: feedback });
      this.escalate(task, agent, project, `${label} không đạt sau nhiều lần`, feedback);
    }
  }
}

module.exports = Runner;
