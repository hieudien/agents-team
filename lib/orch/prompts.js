const store = require('../store');
const agents = require('../agents');
const projectInfo = require('../project');

class Prompts {
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

  isLight(agent) {
    return !!(this.config.roles[agent.role] || {}).lightweight;
  }

  runConfig(agent, task) {
    let roleCfg = this.config.roles[agent.role] || {};
    const esc = this.config.bugEscalation;
    if (esc && agent.role === 'dev' && (task.bugRound || 0) >= (esc.afterRound || 2)) {
      roleCfg = { ...roleCfg, ...(esc.effort ? { effort: esc.effort } : {}), ...(esc.model ? { model: esc.model } : {}) };
    }
    return roleCfg.lightweight && (task.attachments || []).length ? { ...roleCfg, lightTools: 'Read' } : roleCfg;
  }

  extraDirs(agent, task, light) {
    const dirs = light ? [] : [agents.agentDir(agent.id), agents.roleDir(agent.role)];
    if ((task.attachments || []).length) dirs.push(store.uploadsDir(task.projectId));
    return dirs;
  }

  browserFor(roleCfg, task) {
    return !!(roleCfg.browser && task.needsBrowser);
  }

  isWorker(agent) {
    return ['dev', 'tester'].includes(agent.role);
  }

  buildPrompt(task, agent, project) {
    const lines = [
      agents.buildContext(agent, this.config),
      ...(agent.role === 'manager' ? ['', '## Team workload now', this.workloadText()] : []),
      ...(this.isLight(agent) ? ['', projectInfo.overview(project.workspace)] : []),
      ``,
      `# Task ${task.id}: ${task.title}`,
      `From: ${this.nameOf(task.from)} (${task.from})`,
      `Project: ${project.name}`,
      `Workspace (your current directory): ${project.workspace}`
    ];
    if (task.playbook && this.isWorker(agent)) lines.push(`Playbook for this task: read the skill "${task.playbook}" first and follow it.`);
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
    if (this.isWorker(agent)) {
      const notes = (task.waitFor || []).map(id => this.tasks.find(t => t.id === id)).filter(t => t && t.reviewNote).map(t => `- ${t.reviewNote}`);
      if (notes.length) lines.push('', '## Risks flagged by a diff review (check these first)', ...notes);
      const verify = store.readVerify(task.projectId);
      if (verify) lines.push('', '## How to run and verify this project (notes from earlier runs; update via verify_notes when wrong)', verify);
    }
    if (this.isWorker(agent) && (task.bugHistory || []).length) lines.push('', '## Earlier bug reports on this work (do not repeat a fix that already failed; find the root cause)', ...task.bugHistory.map(b => `- ${b}`));
    if (task.gateFeedback) lines.push('', '## Feedback from the previous attempt', task.gateFeedback);
    if (task.userAnswers && task.userAnswers.length) lines.push('', '## Answers from the user to your earlier need_info (continue the task with them)', ...task.userAnswers);
    lines.push('', '## Recent team chat', this.recentChat(task) || '(empty)', '', 'Do the task now, then answer with the JSON object.');
    return lines.join('\n');
  }

  buildCommentPrompt(task, project) {
    const lines = [
      task.commentMode === 'review' ? '# Review' : task.commentMode === 'diff' ? '# Diff review' : '# Open discussion',
      `Project: ${project.name}`,
      `Workspace: ${project.workspace}`,
      '',
      task.commentMode === 'diff' ? '## Task given to the dev' : '## User message',
      task.task,
      ...this.attachmentLines(task)
    ];
    if (task.commentMode === 'diff') lines.push('', '## Changes in the workspace (git status and diff, may be cut)', task.diffText || '(none)');
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

  sanitizeChat(text) {
    let t = String(text || '').replace(/```[\s\S]*?```/g, '[code đã ẩn]').replace(/\s+/g, ' ').trim();
    if (t.length > this.config.chatMaxChars) t = t.slice(0, this.config.chatMaxChars - 1) + '…';
    return t;
  }
}

module.exports = Prompts;
