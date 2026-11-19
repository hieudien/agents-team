const agents = require('../agents');

class Routing {
  child(task, spec) {
    return { projectId: task.projectId, conversationId: task.conversationId, rootId: task.rootId, parentId: task.id, attachments: task.attachments || [], devId: task.devId, needsBrowser: !!task.needsBrowser, bugRound: task.bugRound || 0, bugHistory: task.bugHistory || [], ...spec };
  }

  bugRoundFor(task, agent, target, h) {
    const history = task.bugHistory || [];
    const round = task.bugRound || 0;
    if (agent.role === 'manager') return { round: 0, history: [] };
    if (agent.role !== 'tester' || target.role !== 'dev' || !this.isBug(h)) return { round, history };
    const next = round + 1;
    return { round: next, history: [...history, `Bug report ${next}: ${String(h.title || '').slice(0, 120)} - ${String(h.task || '').slice(0, 300)}`] };
  }

  escalate(task, agent, project, reason, detail) {
    const all = agents.listAgents();
    const targetRole = agent.role === 'manager' ? null : 'manager';
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
    let target = all.find(a => agents.matchesAgent(a, key));
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

  pickByRole(role) {
    const states = this.agentStates().filter(a => a.role === role);
    if (!states.length) return null;
    states.sort((a, b) => a.queue + (a.state === 'working') - (b.queue + (b.state === 'working')));
    return agents.getAgent(states[0].id);
  }

  isBug(h) {
    return h.verdict === 'bug' || /^\s*bug\b/i.test(String(h.title || ''));
  }

  routeTarget(h, task, agent) {
    let target = this.resolveTarget(h.to, agent);
    if (target && agent.role === 'dev' && target.role === 'manager') target = this.pickByRole('tester') || target;
    if (agent.role === 'tester' && this.isBug(h) && task.devId) {
      const dev = agents.getAgent(task.devId);
      if (dev && !dev.retired) target = dev;
    }
    return target;
  }

  diffReviewFor(task, agent, project, target, h) {
    if (!this.comments.adversarialDiff || agent.role !== 'dev' || target.role !== 'tester') return [];
    // The diff itself is read asynchronously when the review runs (see Comments.runCommentInner).
    const review = this.enqueue(
      this.child(task, { kind: 'comment', commentMode: 'diff', from: 'user', to: target.id, title: `Rà diff của ${agent.name}`, task: h.task, checklist: [] }),
      true
    );
    return [review.id];
  }

  cleanConcerns(out, agent) {
    if (!this.isWorker(agent) || !Array.isArray(out.concerns)) return [];
    return out.concerns.map(c => String(c).replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 5);
  }

  dispatch(task, agent, project, out) {
    const concerns = this.cleanConcerns(out, agent);
    for (const raw of out.handoffs || []) {
      const h = concerns.length ? { ...raw, task: `${raw.task}\nConcerns from ${agent.name} (check these first):\n${concerns.map(c => `- ${c}`).join('\n')}` } : raw;
      const target = this.routeTarget(h, task, agent);
      if (!target) {
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `${agent.name} không được giao việc cho "${h.to}", bỏ qua.` });
        continue;
      }
      if (!this.withinBudget(task)) {
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `Đã chạm giới hạn ${this.config.maxTasksPerRequest} task cho yêu cầu này, dừng giao việc.` });
        return;
      }
      const bugs = this.bugRoundFor(task, agent, target, raw);
      if (bugs.round >= (this.config.maxBugRounds || 3) && agent.role === 'tester' && target.role === 'dev') {
        this.post(project.id, task.conversationId, { type: 'system', from: agent.id, text: `Vòng sửa bug đã tới ${bugs.round} lần, không giao lại cho dev nữa mà chuyển PM xem lại hướng làm.` });
        this.escalate(task, agent, project, 'Kẹt vòng sửa bug', bugs.history.join('\n'));
        continue;
      }
      this.post(project.id, task.conversationId, {
        type: 'handoff',
        from: agent.id,
        to: target.id,
        text: h.title,
        data: { task: h.task, checklist: h.checklist || [] }
      });
      const waitFor = this.diffReviewFor(task, agent, project, target, h);
      this.enqueue(
        this.child(task, {
          from: agent.id,
          to: target.id,
          waitFor,
          title: String(h.title || 'Task').slice(0, 80),
          task: h.task,
          checklist: [...(h.checklist || []), ...(agent.role === 'dev' && target.role === 'tester' ? concerns.map(c => `Concern: ${c.slice(0, 100)}`) : [])],
          playbook: ['bug-fix', 'feature', 'refactor'].includes(h.playbook) ? h.playbook : this.isBug(h) && target.role === 'dev' ? 'bug-fix' : undefined,
          devId: target.role === 'dev' ? target.id : agent.role === 'dev' ? agent.id : task.devId,
          bugRound: bugs.round,
          bugHistory: bugs.history,
          needsBrowser: typeof h.needs_browser === 'boolean' ? h.needs_browser : agent.role === 'manager' ? false : !!task.needsBrowser
        })
      );
    }
  }
}

module.exports = Routing;
