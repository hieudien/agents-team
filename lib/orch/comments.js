const store = require('../store');
const agents = require('../agents');
const claude = require('../claude');
const projectInfo = require('../project');

class Comments {
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
    if (!agent || agent.retired || !project) return this.update(task, { status: 'failed' });
    this.update(task, { status: 'running' });
    if (task.commentMode === 'diff' && !task.diffText) {
      task.diffText = await projectInfo.gitDiff(project.workspace);
      if (task.status === 'cancelled') return this.pump();
      if (!task.diffText) {
        this.update(task, { status: 'done', reviewNote: '' });
        return this.pump();
      }
    }
    const roleCfg = { model: this.comments.model, effort: this.comments.effort, permissionMode: 'default', lightweight: true, lightTools: (task.attachments || []).length ? 'Read' : '' };
    const result = await claude.runClaude({
      config: this.config,
      mock: this.mock,
      mode: 'comment',
      agent,
      roleCfg,
      systemFile: agents.buildSystemPrompt(agent, this.config, 'comment'),
      prompt: this.buildCommentPrompt(task, project),
      cwd: project.workspace,
      extraDirs: this.extraDirs(agent, task, true),
      onSpawn: child => this.children.set(task.id, child)
    });
    this.children.delete(task.id);
    if (task.status === 'cancelled') return this.pump();
    if (!result.ok) {
      if (result.kind === 'usage_limit') this.pauseForLimit(result.error, project.id, task.conversationId);
      this.toast(`${agent.name} không góp ý được: ${result.error}`, 'error', result.error);
      this.update(task, { status: 'failed', error: result.error });
      return this.pump();
    }
    const out = result.output;
    agents.appendWorklog(agent.id, { kind: 'comment', project: project.name, taskId: task.id, task: task.title, status: out.speak ? 'spoke' : 'silent', usage: result.usage, costUsd: result.costUsd, durationMs: result.durationMs });
    if (out.speak && String(out.chat || '').trim()) {
      this.post(project.id, task.conversationId, {
        type: 'agent',
        from: agent.id,
        text: this.sanitizeChat(out.chat),
        data: { kind: ['review', 'diff'].includes(task.commentMode) ? 'review' : 'comment', usage: result.usage, costUsd: result.costUsd }
      });
    }
    this.update(task, { status: 'done', reviewNote: out.speak ? this.sanitizeChat(out.chat) : '' });
    this.pump();
  }

  enqueueReviews(task, agent, out) {
    if (!this.comments.reviewOnTag) return;
    const reviewOf = {
      agentId: agent.id,
      status: out.status,
      chat: this.sanitizeChat(out.chat),
      report: out.report_to_user || '',
      handoffs: (out.handoffs || []).map(h => ({ to: h.to, title: h.title, task: String(h.task).slice(0, 600) })),
      checklist: (out.checklist || []).slice(0, 15)
    };
    const reviewers = agents.listAgents().filter(a => !(task.taggedIds || []).includes(a.id) && this.comments.reviewRoles.includes(a.role));
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
}

module.exports = Comments;
