const state = {
  projects: [],
  agents: [],
  conversations: [],
  projectId: localStorage.getItem('projectId') || '',
  conversationId: localStorage.getItem('conversationId') || '',
  mention: { open: false, items: [], index: 0, start: 0 },
  pending: []
};
const $ = id => document.getElementById(id);

const recentToasts = new Map();
function toast(message, level = 'error') {
  const text = String(message && message.message ? message.message : message);
  const last = recentToasts.get(text);
  if (last && Date.now() - last < 4000) return;
  recentToasts.set(text, Date.now());
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = text;
  el.onclick = () => el.remove();
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 8000 : 4000);
}

window.addEventListener('error', e => toast(e.message || 'Lỗi không xác định'));
window.addEventListener('unhandledrejection', e => toast(e.reason || 'Lỗi không xác định'));

const api = async (method, url, body) => {
  let res;
  try {
    res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Không kết nối được server. Kiểm tra cửa sổ terminal đang chạy npm start.');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Server trả về dữ liệu lỗi (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const agentById = id => state.agents.find(a => a.id === id);
const initials = name => String(name || '?').trim().slice(0, 1).toUpperCase();
const timeOf = ts => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
const dateOf = ts => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? timeOf(ts) : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
};

function withMentions(text) {
  return esc(text).replace(/@([\p{L}\p{N}_-]+)/gu, (all, name) => {
    const key = name.toLowerCase();
    const hit = state.agents.find(a => a.name.toLowerCase() === key || a.id === key || (a.aliases || []).some(x => x.toLowerCase() === key));
    return hit ? `<span class="mention">@${esc(hit.name)}</span>` : all;
  });
}

function avatar(agent, small) {
  const color = agent ? agent.color : '#6e7781';
  const dot = agent && !small ? `<span class="dot ${agent.state || ''}"></span>` : '';
  return `<div class="avatar ${small ? 'small' : ''}" style="background:${color}">${esc(initials(agent ? agent.name : '?'))}${dot}</div>`;
}

function renderAgents() {
  $('agentList').innerHTML = state.agents
    .map(a => {
      const sub = a.state === 'working' ? `Đang làm: ${a.currentTask}` : a.state === 'commenting' ? 'Đang góp ý…' : a.queue ? `Chờ ${a.queue} việc` : a.title;
      return `<div class="agent" data-id="${a.id}">${avatar(a)}<div class="agent-meta"><div class="agent-name">${esc(a.name)} <span class="agent-sub">@${esc(a.name)}</span></div><div class="agent-sub" title="${esc(sub)}">${esc(sub)}${a.queue && a.state === 'working' ? ` · chờ ${a.queue}` : ''}</div></div></div>`;
    })
    .join('');
  $('stopBtn').classList.toggle('hidden', !state.agents.some(a => a.state !== 'idle' || a.queue > 0));
}

async function openDirect(agentId) {
  if (!state.projectId) return toast('Tạo dự án trước');
  const conv = await api('POST', `/api/projects/${state.projectId}/conversations`, { agentId });
  if (!state.conversations.find(c => c.id === conv.id)) state.conversations.unshift(conv);
  document.querySelector('.tab[data-tab="conversations"]').click();
  selectConversation(conv.id);
  $('input').focus();
}

function renderProjects() {
  $('projectSelect').innerHTML = state.projects.map(p => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const p = state.projects.find(x => x.id === state.projectId);
  $('projectPath').textContent = p ? `${p.name} · ${p.workspace}` : 'Bấm + để tạo dự án';
}

function renderConversations() {
  const conv = state.conversations.find(c => c.id === state.conversationId);
  $('convTitle').textContent = state.projectId ? (conv ? conv.title : 'Cuộc trò chuyện mới') : 'Chưa có dự án';
  const direct = conv && conv.directAgentId ? agentById(conv.directAgentId) : null;
  $('input').placeholder = direct ? `Nhắn riêng với ${direct.name}… (Alt+Enter gửi, Enter xuống dòng)` : 'Nhắn cả team, gõ @ để tag agent, Ctrl+V để dán ảnh… (Alt+Enter gửi, Enter xuống dòng)';
  $('convList').innerHTML =
    state.conversations
      .map(
        c => `<div class="conv ${c.id === state.conversationId ? 'active' : ''}" data-id="${c.id}" title="Nhấp đúp để đổi tên">
          <div class="conv-title">${c.active ? '<span class="live"></span>' : ''}${esc(c.title)}</div>
          <div class="conv-sub">${dateOf(c.updatedAt)} · ${esc(c.lastText || '…')}</div>
        </div>`
      )
      .join('') || '<div class="conv-sub">Chưa có cuộc trò chuyện</div>';
}

function thumbsHtml(list) {
  if (!list || !list.length) return '';
  return `<div class="thumbs">${list.map(a => `<a href="${esc(a.url)}" target="_blank"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`).join('')}</div>`;
}

function checklistHtml(list) {
  if (!list || !list.length) return '';
  const ok = list.filter(c => c.pass).length;
  const items = list.map(c => `<li>${c.pass ? '✅' : '❌'} ${esc(c.item)}${c.evidence ? ` <span class="ev">— ${esc(c.evidence)}</span>` : ''}</li>`).join('');
  return `<details><summary>Checklist ${ok}/${list.length}</summary><ul class="check">${items}</ul></details>`;
}

const STATUS_LABEL = { done: 'xong', blocked: 'bị chặn', need_info: 'cần thông tin' };
const KIND_LABEL = { comment: 'góp ý', review: 'phản biện' };

const fmtTok = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function usageHtml(u, cost) {
  if (!u) return '';
  const title = `input ${u.input}, output ${u.output}, cache read ${u.cacheRead}, cache write ${u.cacheCreate}${typeof cost === 'number' ? `, $${cost.toFixed(4)}` : ''}`;
  return `<div class="usage" title="${esc(title)}">${fmtTok(u.input + u.cacheRead + u.cacheCreate)} in · ${fmtTok(u.output)} out</div>`;
}

function messageHtml(m) {
  const a = agentById(m.from);
  const name = a ? a.name : m.from;
  const to = agentById(m.to);
  switch (m.type) {
    case 'user':
      return `<div class="msg user"><div class="bubble">${withMentions(m.text)}${thumbsHtml(m.data && m.data.attachments)}</div></div>`;
    case 'agent': {
      const d = m.data || {};
      const badge = d.kind ? `<span class="kind ${d.kind}">${KIND_LABEL[d.kind]}</span>` : d.status ? `<span class="status ${d.status}">${STATUS_LABEL[d.status] || d.status}</span>` : '';
      return `<div class="msg">${avatar(a, true)}<div><div class="who"><b>${esc(name)}</b> · ${esc(a ? a.title : '')}<span class="time">${timeOf(m.ts)}</span>${badge}</div><div class="bubble">${withMentions(m.text)}${checklistHtml(d.checklist)}</div>${usageHtml(d.usage, d.costUsd)}</div></div>`;
    }
    case 'handoff': {
      const detail = m.data && m.data.task
        ? `<details><summary>Chi tiết</summary><div class="task-text">${esc(m.data.task)}</div>${m.data.checklist && m.data.checklist.length ? `<ul class="check">${m.data.checklist.map(c => `<li>☐ ${esc(c)}</li>`).join('')}</ul>` : ''}</details>`
        : '';
      return `<div class="line handoff">📌 <b>${esc(name)}</b> → <b>${esc(to ? to.name : m.to)}</b>: ${esc(m.text)}${detail}</div>`;
    }
    case 'report':
      return `<div class="card report"><b>📋 Báo cáo từ ${esc(name)}</b>\n${esc(m.text)}</div>`;
    case 'question':
      return `<div class="card question"><b>❓ ${esc(name)} hỏi:</b> ${esc(m.text)}</div>`;
    case 'proposal':
      return `<div class="card proposal"><div><b>💡 ${esc(name)} đề xuất thêm ${esc(m.data.role)}:</b> ${esc(m.text)}</div><button data-create-role="${esc(m.data.role)}" data-reason="${esc(m.text)}">Tạo ${esc(m.data.role)}</button></div>`;
    default: {
      const problems = m.data && m.data.problems ? `<details><summary>Chi tiết</summary><ul class="check">${m.data.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>` : '';
      return `<div class="line system">${esc(m.text)}${problems}</div>`;
    }
  }
}

function appendMessage(m) {
  const chat = $('chat');
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  chat.insertAdjacentHTML('beforeend', messageHtml(m));
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

async function loadChat() {
  $('chat').innerHTML = '';
  if (!state.projectId || !state.conversationId) return;
  const messages = await api('GET', `/api/projects/${state.projectId}/conversations/${state.conversationId}/chat?limit=300`);
  messages.forEach(appendMessage);
  $('chat').scrollTop = $('chat').scrollHeight;
}

async function loadConversations() {
  state.conversations = state.projectId ? await api('GET', `/api/projects/${state.projectId}/conversations`) : [];
  if (!state.conversations.find(c => c.id === state.conversationId)) state.conversationId = state.conversations[0] ? state.conversations[0].id : '';
  renderConversations();
}

function selectConversation(id) {
  state.conversationId = id;
  localStorage.setItem('conversationId', id);
  renderConversations();
  loadChat();
}

async function selectProject(id) {
  state.projectId = id;
  localStorage.setItem('projectId', id);
  renderProjects();
  await loadConversations();
  localStorage.setItem('conversationId', state.conversationId);
  await loadChat();
}

async function init() {
  const s = await api('GET', '/api/state');
  state.projects = s.projects;
  state.agents = s.agents;
  $('mockBadge').classList.toggle('hidden', !s.mock);
  if (!state.projects.find(p => p.id === state.projectId)) state.projectId = state.projects[0] ? state.projects[0].id : '';
  renderAgents();
  await selectProject(state.projectId);
  const es = new EventSource('/events');
  let disconnected = false;
  es.onerror = () => {
    if (!disconnected) toast('Mất kết nối tới server, đang thử kết nối lại…');
    disconnected = true;
  };
  es.onopen = () => {
    if (disconnected) {
      toast('Đã kết nối lại server', 'success');
      init().catch(toast);
      es.close();
    }
    disconnected = false;
  };
  es.onmessage = e => {
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.type === 'toast') toast(ev.message, ev.level);
    if (ev.type === 'agents') {
      state.agents = ev.agents;
      renderAgents();
    }
    if (ev.type === 'conversations' && ev.projectId === state.projectId) {
      state.conversations = ev.conversations;
      renderConversations();
    }
    if (ev.type === 'chat' && ev.projectId === state.projectId && ev.conversationId === state.conversationId) appendMessage(ev.message);
  };
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${btn.dataset.tab}`));
  };
});

$('projectSelect').onchange = e => selectProject(e.target.value);

$('newProjectBtn').onclick = () => $('projectDialog').showModal();
$('pickFolderBtn').onclick = async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Đang mở…';
  try {
    const res = await api('POST', '/api/pick-folder', {});
    if (res.path) {
      const input = document.querySelector('#projectForm input[name="workspace"]');
      input.value = res.path;
      const name = document.querySelector('#projectForm input[name="name"]');
      if (!name.value) name.value = res.path.split(/[\\/]/).pop();
    }
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Chọn…';
  }
};
$('projectForm').onsubmit = async e => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  const f = new FormData(e.target);
  try {
    const p = await api('POST', '/api/projects', { name: f.get('name'), workspace: f.get('workspace'), verifyCmd: f.get('verifyCmd') });
    state.projects.push(p);
    await selectProject(p.id);
    e.target.reset();
  } catch (err) {
    toast(err.message);
  }
};

$('newConvBtn').onclick = async () => {
  if (!state.projectId) return toast('Tạo dự án trước');
  const conv = await api('POST', `/api/projects/${state.projectId}/conversations`, {});
  state.conversations.unshift(conv);
  selectConversation(conv.id);
  $('input').focus();
};

$('convList').onclick = e => {
  const el = e.target.closest('.conv');
  if (el) selectConversation(el.dataset.id);
};

$('convList').ondblclick = async e => {
  const el = e.target.closest('.conv');
  if (!el) return;
  const conv = state.conversations.find(c => c.id === el.dataset.id);
  const title = prompt('Đổi tên cuộc trò chuyện', conv ? conv.title : '');
  if (title) await api('POST', `/api/projects/${state.projectId}/conversations/${el.dataset.id}/rename`, { title });
};

$('composer').onsubmit = async e => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (state.pending.some(a => a.loading)) return toast('Đợi ảnh tải lên xong đã nhé', 'info');
  if (!text && !state.pending.length) return;
  if (!state.projectId) return toast('Tạo dự án trước');
  const attachments = state.pending.map(({ name, file }) => ({ name, file }));
  $('input').value = '';
  state.pending = [];
  renderAttachBar();
  closeMention();
  try {
    const res = await api('POST', `/api/projects/${state.projectId}/messages`, { text, attachments, conversationId: state.conversationId });
    if (res.conversationId !== state.conversationId) {
      await loadConversations();
      selectConversation(res.conversationId);
    }
  } catch (err) {
    toast(err.message);
  }
};

function renderAttachBar() {
  const bar = $('attachBar');
  bar.classList.toggle('hidden', !state.pending.length);
  bar.innerHTML = state.pending
    .map((a, i) => `<div class="attach-item ${a.loading ? 'loading' : ''}" title="${esc(a.name)}"><img src="${a.preview}" alt=""><button type="button" data-remove="${i}">×</button></div>`)
    .join('');
}

const readAsDataUrl = file =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Không đọc được ảnh'));
    reader.readAsDataURL(file);
  });

async function addImages(files) {
  const images = [...files].filter(f => f.type.startsWith('image/'));
  if (!images.length) return;
  if (!state.projectId) return toast('Tạo dự án trước khi gửi ảnh');
  for (const file of images) {
    if (file.size > 10 * 1024 * 1024) {
      toast(`Ảnh "${file.name}" lớn hơn 10MB`);
      continue;
    }
    const item = { name: file.name || 'pasted.png', preview: '', loading: true };
    try {
      item.preview = await readAsDataUrl(file);
      state.pending.push(item);
      renderAttachBar();
      const saved = await api('POST', `/api/projects/${state.projectId}/uploads`, { name: item.name, dataUrl: item.preview });
      Object.assign(item, { file: saved.file, url: saved.url, loading: false });
    } catch (err) {
      state.pending = state.pending.filter(x => x !== item);
      toast(`Không tải được ảnh: ${err.message}`);
    }
    renderAttachBar();
  }
}

$('input').addEventListener('paste', e => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (files.some(f => f.type.startsWith('image/'))) {
    e.preventDefault();
    addImages(files);
  }
});
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  addImages(e.target.files);
  e.target.value = '';
};
$('attachBar').onclick = e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  state.pending.splice(Number(btn.dataset.remove), 1);
  renderAttachBar();
};
$('composer').addEventListener('dragover', e => {
  e.preventDefault();
  $('composer').classList.add('dragover');
});
$('composer').addEventListener('dragleave', () => $('composer').classList.remove('dragover'));
$('composer').addEventListener('drop', e => {
  e.preventDefault();
  $('composer').classList.remove('dragover');
  addImages(e.dataTransfer.files);
});

function mentionQuery() {
  const input = $('input');
  const before = input.value.slice(0, input.selectionStart);
  const m = before.match(/(^|\s)@([\p{L}\p{N}_-]*)$/u);
  return m ? { query: m[2].toLowerCase(), start: before.length - m[2].length - 1 } : null;
}

function renderMention() {
  const menu = $('mentionMenu');
  const { open, items, index } = state.mention;
  menu.classList.toggle('hidden', !open);
  if (!open) return;
  menu.innerHTML = items
    .map((a, i) => `<div class="mention-item ${i === index ? 'active' : ''}" data-i="${i}">${avatar(a, true)}<div><b>${esc(a.name)}</b><div class="agent-sub">${esc(a.title)}</div></div></div>`)
    .join('');
}

function closeMention() {
  state.mention.open = false;
  renderMention();
}

function updateMention() {
  const q = mentionQuery();
  if (!q) return closeMention();
  const items = state.agents.filter(a => a.name.toLowerCase().startsWith(q.query) || a.id.startsWith(q.query) || a.title.toLowerCase().includes(q.query));
  state.mention = { open: items.length > 0, items, index: 0, start: q.start };
  renderMention();
}

function pickMention(i) {
  const agent = state.mention.items[i];
  if (!agent) return;
  const input = $('input');
  const caret = input.selectionStart;
  const insert = `@${agent.name} `;
  input.value = input.value.slice(0, state.mention.start) + insert + input.value.slice(caret);
  const pos = state.mention.start + insert.length;
  input.setSelectionRange(pos, pos);
  input.focus();
  closeMention();
}

$('input').oninput = updateMention;
$('input').onclick = updateMention;
$('input').onblur = () => setTimeout(closeMention, 150);
$('mentionMenu').onmousedown = e => {
  const el = e.target.closest('.mention-item');
  if (!el) return;
  e.preventDefault();
  pickMention(Number(el.dataset.i));
};

$('input').onkeydown = e => {
  const m = state.mention;
  if (m.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      m.index = (m.index + (e.key === 'ArrowDown' ? 1 : -1) + m.items.length) % m.items.length;
      return renderMention();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      return pickMention(m.index);
    }
    if (e.key === 'Escape') return closeMention();
  }
  if (e.key === 'Enter' && e.altKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
};

$('stopBtn').onclick = () => confirm('Dừng mọi việc đang chạy và đang chờ?') && api('POST', '/api/stop');

const createAgent = (role, reason) => api('POST', '/api/agents', { role, reason, projectId: state.projectId, conversationId: state.conversationId }).catch(err => toast(err.message));
$('addDevBtn').onclick = () => createAgent('dev', 'Thêm thủ công');
$('addTesterBtn').onclick = () => createAgent('tester', 'Thêm thủ công');

$('chat').onclick = e => {
  const btn = e.target.closest('[data-create-role]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Đã tạo';
  createAgent(btn.dataset.createRole, btn.dataset.reason);
};

function insertMention(agent) {
  const input = $('input');
  const sep = input.value && !input.value.endsWith(' ') ? ' ' : '';
  input.value += `${sep}@${agent.name} `;
  input.focus();
}

function usageText(u) {
  if (!u || !u.runs) return '(chưa có)';
  return `${u.runs} lượt · input ${fmtTok(u.input)} · output ${fmtTok(u.output)} · cache đọc ${fmtTok(u.cacheRead)} · cache ghi ${fmtTok(u.cacheCreate)} · $${u.costUsd.toFixed(4)}`;
}

$('agentList').onclick = async e => {
  const el = e.target.closest('.agent');
  if (!el) return;
  const d = await api('GET', `/api/agents/${el.dataset.id}`);
  const p = d.profile;
  const log = d.worklog.slice().reverse().map(w => `${w.ts.slice(0, 16).replace('T', ' ')} [${w.project}] ${w.task} → ${w.status} (${w.checklist})`).join('\n');
  $('agentDetail').innerHTML = `
    <div style="display:flex;gap:12px;align-items:center">${avatar(agentById(p.id) || p)}<div><h3 style="margin:0">${esc(p.name)} <span class="agent-sub">@${esc(p.name)}</span></h3><div class="agent-sub">${esc(p.title)} · ${esc(p.id)}</div></div></div>
    <p>${esc(p.bio)}</p><p><b>Tính cách:</b> ${esc(p.personality)}</p>
    <b>Skill</b><div class="pre">${esc(d.skills.map(s => `${s.name}: ${s.description}`).join('\n') || '(trống)')}</div>
    <b>Rule riêng</b><div class="pre">${esc(d.rules || '(trống)')}</div>
    <b>Memory</b><div class="pre">${esc(d.memory || '(trống)')}</div>
    <b>Token đã dùng</b><div class="pre">${esc(usageText(d.usage))}</div>
    <b>Lịch sử làm việc</b><div class="pre">${esc(log || '(trống)')}</div>
    <p><button id="dmAgentBtn">Nhắn riêng</button> <button id="tagAgentBtn">Tag @${esc(p.name)}</button> <button class="ghost" id="resetSessionBtn">Phiên mới cho dự án này</button></p>
    <p class="agent-sub">Phiên mới: giữ memory + lịch sử, chỉ bỏ ngữ cảnh hội thoại dài.</p>`;
  $('dmAgentBtn').onclick = () => {
    $('agentDialog').close();
    openDirect(p.id).catch(toast);
  };
  $('tagAgentBtn').onclick = () => {
    $('agentDialog').close();
    insertMention(p);
  };
  $('resetSessionBtn').onclick = async () => {
    await api('POST', `/api/agents/${p.id}/reset-session`, { projectId: state.projectId });
    $('resetSessionBtn').textContent = 'Đã reset';
  };
  $('agentDialog').showModal();
};

init().catch(toast);
