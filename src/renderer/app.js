'use strict';
/* global Terminal, FitAddon */
// Renderer: agent list, office floor, terminals, tasks, board, memory, ask-me, log.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#f2b544', '#3ec7b0', '#6ea8fe', '#b190ff', '#ef8a62', '#7bd88f', '#f07ab8', '#5fd3e8'];
const colorFor = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const time = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ''; } };
const RUNNING = ['working', 'idle', 'waiting', 'starting'];
const STATUS_LABEL = { working: 'Working', idle: 'Idle', waiting: 'Needs you', starting: 'Starting', exited: 'Exited', stopped: 'Stopped', error: 'Error' };
const PROVIDER_SHORT = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', shell: 'Shell', custom: 'Custom' };

const state = { settings: {}, providers: {}, agents: [], selected: null, tab: 'floor', hiveRoot: '' };
const terms = new Map(); // id -> { term, fit, host, ready, pending }

function toast(text, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 6000 : 2800);
}

function agentById(id) { return state.agents.find((a) => a.id === id); }
function god() { return state.agents.find((a) => a.isGod); }
function nameOf(id) { if (id === 'human') return 'You'; const a = agentById(id); return a ? a.name : id; }

// ---------------- agents list + floor ----------------
async function refreshAgents() {
  state.agents = await window.hd.agents();
  renderAgents();
}

function renderAgents() {
  const busy = state.agents.filter((a) => a.status === 'working').length;
  $('#agentCount').textContent = `${state.agents.length} agent${state.agents.length === 1 ? '' : 's'} · ${busy} working`;
  $('#agentList').innerHTML = state.agents.map((a) => `
    <div class="agent st-${esc(a.status)} ${state.selected === a.id ? 'selected' : ''}" data-id="${esc(a.id)}">
      <div class="avatar" style="--c:${colorFor(a.id)}">${esc(initials(a.name))}</div>
      <div class="who"><div class="name">${esc(a.name)}${a.isGod ? ' <span class="star">&#9733;</span>' : ''}</div>
        <div class="sub">${esc(STATUS_LABEL[a.status] || a.status)} · ${esc(PROVIDER_SHORT[a.provider] || a.provider)}${a.lastTool ? ' · ' + esc(a.lastTool) : ''}</div></div>
      ${a.unread ? `<span class="unread">${a.unread}</span>` : (a.isGod ? '<span class="lead">LEAD</span>' : '<span></span>')}
    </div>`).join('') || '<div class="empty small">No agents yet.</div>';
  renderFloor();
  const g = god();
  $('#godName').textContent = g ? g.name : 'the orchestrator';
  const asg = $('#taskAssignee');
  const curA = asg.value;
  asg.innerHTML = '<option value="">Unassigned</option>' + state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  asg.value = curA;
  const memSel = $('#memAgent');
  const cur = memSel.value;
  memSel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (cur) memSel.value = cur;
  if (state.selected) renderTermHead();
  if (state.tab === 'team') loadTeam();
}

// The floor is a pixel office (office.js): every agent is a character driven by its real status.
function renderFloor() {
  const asks = Number($('#askBadge').textContent) || 0;
  window.Office.sync(state.agents.map((a) => ({ ...a, color: colorFor(a.id) })), { asks });
}

window.Office.init($('#floor'), {
  onOpen: (id) => { if (id === 'human') showTab('ask'); else selectAgent(id); },
  // Allow/Deny are only offered for Claude permission prompts and only act when you click:
  // Enter picks the dialog's default "Yes", Esc cancels it.
  onAllow: (id) => window.hd.write(id, '\r'),
  onDeny: (id) => window.hd.write(id, '\x1b'),
});

// ---------------- terminal ----------------
function selectAgent(id, openTerminal = true) {
  state.selected = id;
  renderAgents();
  if (openTerminal) showTab('terminal');
  else showTerminal(id);
}

function renderTermHead() {
  const a = agentById(state.selected);
  if (!a) { $('#termHead').innerHTML = ''; return; }
  const running = RUNNING.includes(a.status);
  $('#termHead').innerHTML = `
    <span class="title">${esc(a.name)}</span>
    <span class="meta">${esc(a.provider)}${a.model ? ' · ' + esc(a.model) : ''} · ${esc(a.status)} · ${esc(a.cwd || state.settings.workspace)}</span>
    ${running ? '<button data-act="stop">Stop</button>' : '<button class="primary" data-act="start">Start / resume</button>'}
    <button data-act="custom" title="Rename, change model, effort, manager and instructions">Customize</button>
    <button data-act="fresh" title="Restart with a brand new session">New session</button>
    <button data-act="folder">Hive folder</button>
    <button data-act="cwd">Work folder</button>
    <button class="danger" data-act="remove">Archive</button>`;
  renderCtlBar();
  const old = $('#termWrap .err');
  if (old) old.remove();
  if (a.error && state.tab === 'terminal') {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = a.error;
    $('#termWrap').appendChild(e);
  }
}

async function ensureTerm(id) {
  if (terms.has(id)) return terms.get(id);
  const host = document.createElement('div');
  host.className = 'term-host';
  host.style.display = 'none';
  $('#termWrap').appendChild(host);
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 5000,
    theme: { background: '#1d1d1f', foreground: '#f5f5f7', cursor: '#f6c445', selectionBackground: '#4a4a4f' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.onData((d) => window.hd.write(id, d));
  term.onResize(({ cols, rows }) => window.hd.resize(id, cols, rows));
  const entry = { term, fit, host, ready: false, pending: [] };
  terms.set(id, entry);
  const past = await window.hd.replay(id);
  if (past) term.write(past);
  entry.ready = true;
  entry.pending.forEach((d) => term.write(d));
  entry.pending = [];
  return entry;
}

async function showTerminal(id) {
  const empty = $('#termWrap .empty');
  if (empty) empty.remove();
  const entry = await ensureTerm(id);
  for (const [k, t] of terms) t.host.style.display = k === id ? 'block' : 'none';
  renderTermHead();
  setTimeout(() => { try { entry.fit.fit(); window.hd.resize(id, entry.term.cols, entry.term.rows); entry.term.focus(); } catch {} }, 30);
}

new ResizeObserver(() => {
  const e = terms.get(state.selected);
  if (e && state.tab === 'terminal') { try { e.fit.fit(); } catch {} }
}).observe($('#termWrap'));

$('#termHead').addEventListener('click', async (ev) => {
  const act = ev.target.dataset.act;
  const id = state.selected;
  if (!act || !id) return;
  const a = agentById(id);
  if (act === 'stop') await window.hd.stopAgent(id);
  if (act === 'start') { const r = await window.hd.startAgent(id); if (!r.ok) toast(r.error, true); }
  if (act === 'fresh') {
    if (!confirm(`Start ${a.name} with a brand new session? Its conversation history is not resumed.`)) return;
    const r = await window.hd.freshAgent(id); if (!r.ok) toast(r.error, true);
  }
  if (act === 'custom') { openCustom('agent', id); return; }
  if (act === 'folder') window.hd.openPath(`${state.hiveRoot}\\agents\\${id}`);
  if (act === 'cwd') window.hd.openPath(a.cwd || state.settings.workspace);
  if (act === 'remove') {
    if (!confirm(`Archive ${a.name}? The process stops; its memory and messages stay in the hive.`)) return;
    await window.hd.removeAgent(id);
    const t = terms.get(id); if (t) { t.term.dispose(); t.host.remove(); terms.delete(id); }
    state.selected = null;
    $('#termHead').innerHTML = '';
  }
  await refreshAgents();
});

// ---------------- model / effort control bar (Claude agents) ----------------
const MODELS = [['', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORT_LEVELS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'XHigh'], ['max', 'Max']];

function renderCtlBar() {
  const bar = $('#ctlBar');
  const a = agentById(state.selected);
  if (!a || a.provider !== 'claude') { bar.classList.add('hidden'); return; }
  if (document.activeElement && document.activeElement.id === 'ctlModel') return; // never rebuild under the user's typing
  const cur = { model: a.model || '', effort: a.effort || '' };
  const seg = (kind, opts) => `<div class="seg" role="group" aria-label="${kind}">${opts.map(([v, l]) => `<button type="button" data-${kind}="${v}" class="${cur[kind] === v ? 'on' : ''}" aria-pressed="${cur[kind] === v}">${l}</button>`).join('')}</div>`;
  const custom = cur.model && !MODELS.some(([v]) => v === cur.model);
  bar.innerHTML = `<span class="lbl">Model</span>${seg('model', MODELS)}
    <input id="ctlModel" placeholder="custom model id" value="${custom ? esc(cur.model) : ''}" title="Any model id or alias, press Enter" aria-label="Custom model id">
    <span class="lbl">Effort</span>${seg('effort', EFFORT_LEVELS)}
    <span class="hint">${RUNNING.includes(a.status) ? 'Applies live (/model, /effort) once the agent is idle' : 'Saved for the next start'}</span>`;
  bar.classList.remove('hidden');
}
async function applyCtl(patch) {
  const a = agentById(state.selected);
  if (!a) return;
  const r = await window.hd.configureAgent(a.id, patch);
  if (!r.ok) { toast(r.error, true); return; }
  const what = patch.model !== undefined ? `model ${patch.model || 'default'}` : `effort ${patch.effort || 'default'}`;
  toast({ now: `${a.name}: ${what} applied`, 'when idle': `${a.name}: ${what} queued until idle`, 'next start': `${a.name}: ${what} saved for the next start` }[r.applied] || 'Saved');
  await refreshAgents();
}
$('#ctlBar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if ('model' in b.dataset) applyCtl({ model: b.dataset.model });
  else if ('effort' in b.dataset) applyCtl({ effort: b.dataset.effort });
});
$('#ctlBar').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'ctlModel') applyCtl({ model: e.target.value.trim() }); });

// ---------------- Claude Code mirror: every chat you run in Claude Code, read-only ----------------
const live = { sessions: [], selected: null, key: '', lastPrompt: '', last: 0 };
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };

async function pollLive(force) {
  if (!force && state.tab !== 'live' && Date.now() - live.last < 15000) return; // cheap background refresh for the badge
  live.last = Date.now();
  live.sessions = await window.hd.mirrorList();
  const working = live.sessions.filter((s) => s.working).length;
  $('#liveBadge').textContent = working;
  $('#liveBadge').classList.toggle('hidden', !working);
  if (state.tab !== 'live') return;
  renderLiveList();
  if (live.selected) await renderLiveChat(force);
}
function renderLiveList() {
  $('#liveList').innerHTML = live.sessions.map((s) => `
    <div class="live-item ${s.id === live.selected ? 'selected' : ''} ${s.working ? 'working' : ''}" data-id="${esc(s.id)}">
      <div class="li-top"><span class="dot"></span><b>${esc(s.project)}</b><span class="hint">${esc(s.working ? 'working' : ago(s.mtime))}</span></div>
      <div class="li-title">${esc(s.title)}</div>
      ${s.model ? `<span class="chip">${esc(s.model)}</span>` : ''}
    </div>`).join('') || '<div class="empty small">No Claude Code chats in the last 3 days.</div>';
}
async function renderLiveChat(reset) {
  const s = live.sessions.find((x) => x.id === live.selected);
  if (!s) return;
  $('#liveHead').innerHTML = `<span class="title">${esc(s.project)}</span><span class="meta">${esc(s.cwd)}${s.model ? ' · ' + esc(s.model) : ''} · ${s.working ? 'working' : 'idle'}</span>`;
  const r = await window.hd.mirrorRead(s.id, 200);
  const box = $('#liveMsgs');
  if (!r.ok) { box.innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  const key = `${s.id}:${r.messages.length}:${r.mtime}`;
  if (key === live.key && !reset) return;
  live.key = key;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = r.messages.map((m) => m.role === 'tool'
    ? `<div class="msg tool"><span class="chip">${esc(m.name)}</span><span class="mono">${esc(m.text)}</span></div>`
    : `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? 'You' : 'Claude'}<span class="hint">${esc(time(m.t))}</span></div><div class="body">${esc(m.text)}</div></div>`).join('') || '<div class="empty">No messages to show yet.</div>';
  if (reset || atBottom) box.scrollTop = box.scrollHeight;
  const lastUser = [...r.messages].reverse().find((m) => m.role === 'user');
  live.lastPrompt = lastUser ? lastUser.text : '';
  $('#liveDelegate').classList.remove('hidden');
  const sel = $('#liveAgent');
  if (sel.options.length !== state.agents.length) {
    const g = god();
    sel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.isGod ? ' (orchestrator)' : ''}</option>`).join('');
    if (g) sel.value = g.id;
  }
}
$('#liveList').addEventListener('click', (e) => {
  const el = e.target.closest('.live-item');
  if (!el) return;
  live.selected = el.dataset.id;
  renderLiveList();
  renderLiveChat(true);
});
$('#liveSend').onclick = async () => {
  const to = $('#liveAgent').value;
  const s = live.sessions.find((x) => x.id === live.selected);
  const text = $('#liveTask').value.trim() || live.lastPrompt;
  if (!to) { toast('Hire an agent first', true); return; }
  if (!s || !text) { toast('Nothing to delegate yet', true); return; }
  await window.hd.sendMessage({ to, act: 'request', subject: text.split('\n')[0].slice(0, 80), body: `${text}\n\n(Delegated from the Claude Code chat "${s.title}" in ${s.cwd}.)` });
  $('#liveTask').value = '';
  toast(`Delegated to ${nameOf(to)}`);
};
setInterval(() => pollLive(false), 3000);

// ---------------- tabs ----------------
function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${tab}`));
  window.Office.setActive(tab === 'floor');
  if (tab === 'team') loadTeam();
  if (tab === 'tasks') loadTasks();
  if (tab === 'board') loadBoard();
  if (tab === 'memory') loadMemory();
  if (tab === 'ask') loadAsk();
  if (tab === 'log') loadLog();
  if (tab === 'terminal' && state.selected) showTerminal(state.selected);
  if (tab === 'live') pollLive(true);
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$('#agentList').addEventListener('click', (e) => { const el = e.target.closest('.agent'); if (el) selectAgent(el.dataset.id); });

// ---------------- team: org chart, crew library, workflow, customize ----------------
// Chain of command: you > orchestrator (god) > managers > employees. An unknown or looping manager means "the orchestrator".
function managerOf(a) {
  if (a.isGod) return null;
  const ids = new Set(state.agents.map((x) => x.id));
  const g = god();
  if (!a.reportsTo || a.reportsTo === a.id || !ids.has(a.reportsTo)) return g ? g.id : null;
  return a.reportsTo;
}
function descendants(id, seen = new Set()) {
  for (const a of state.agents) if (!seen.has(a.id) && managerOf(a) === id) { seen.add(a.id); descendants(a.id, seen); }
  return seen;
}
const agentForPreset = (pid) => state.agents.find((a) => a.presetId === pid);
const presetName = (pid) => (state.presets[pid] ? state.presets[pid].name : pid);

function orgNode(a, depth) {
  const kids = state.agents.filter((x) => x.id !== a.id && managerOf(x) === a.id);
  return `<div class="org-node" style="--d:${depth}">
      <div class="org-card st-${esc(a.status)}" data-id="${esc(a.id)}">
        <div class="avatar" style="--c:${colorFor(a.id)}">${esc(initials(a.name))}</div>
        <div class="who"><div class="name">${esc(a.name)}${a.isGod ? ' <span class="star">&#9733;</span>' : ''}</div>
          <div class="sub">${esc(a.role)}</div>
          <div class="sub">${esc(STATUS_LABEL[a.status] || a.status)} · ${esc(PROVIDER_SHORT[a.provider] || a.provider)}${a.model ? ' · ' + esc(a.model) : ''}${a.effort ? ' · ' + esc(a.effort) : ''}${kids.length ? ` · ${kids.length} report${kids.length === 1 ? '' : 's'}` : ''}</div></div>
        <div class="org-btns"><button data-act="open">Open</button><button data-act="custom">Customize</button></div>
      </div>${kids.map((k) => orgNode(k, depth + 1)).join('')}</div>`;
}
function renderOrg() {
  const g = god();
  const seen = new Set(g ? [g.id, ...descendants(g.id)] : []);
  const strays = state.agents.filter((a) => !seen.has(a.id) && a !== g);
  $('#orgTree').innerHTML = `<div class="org-node" style="--d:0"><div class="org-card you"><div class="avatar" style="--c:#8e8e93">YOU</div><div class="who"><div class="name">You</div><div class="sub">The orchestrator reports to you</div></div></div>
    ${g ? orgNode(g, 1) : '<div class="empty small">No orchestrator yet.</div>'}${strays.map((a) => orgNode(a, 1)).join('')}</div>`;
}
function renderCrew() {
  $('#crewList').innerHTML = Object.values(state.presets || {}).map((p) => {
    const hired = agentForPreset(p.id);
    const boss = p.reportsTo === 'god' || !p.reportsTo ? 'orchestrator' : presetName(p.reportsTo);
    return `<div class="crew-card" data-preset="${esc(p.id)}">
      <div class="who"><div class="name">${esc(p.name)}${p.customized ? ' <span class="chip">edited</span>' : ''}${hired ? ' <span class="chip ok">hired</span>' : ''}</div>
        <div class="sub">${esc(p.role)}</div><div class="sub">Reports to ${esc(boss)} · ${esc(p.model || 'default model')} · ${esc(p.effort || 'default')} effort</div></div>
      <div class="org-btns"><button data-act="hire">${hired ? 'Hire another' : 'Hire'}</button><button data-act="custom">Customize</button></div>
    </div>`;
  }).join('');
  const prev = new Set([...document.querySelectorAll('#teamRoles input:not(:checked)')].map((i) => i.value));
  $('#teamRoles').innerHTML = (state.productionTeam || []).map((pid) => `<label class="check"><input type="checkbox" value="${esc(pid)}" ${prev.has(pid) ? '' : 'checked'}> ${esc(presetName(pid))}${agentForPreset(pid) ? ' (hired)' : ''}</label>`).join('');
}
function renderWorkflow() {
  $('#workflow').innerHTML = (state.workflow || []).map((s, i) => `<div class="wf-step"><div class="wf-n">${i + 1}</div><div>
      <div class="name">${esc(s.stage)} <span class="hint">${s.who.map((w) => esc(w === 'god' ? (god() ? god().name : 'Orchestrator') : presetName(w))).join(' + ')}</span></div>
      <div class="sub">${esc(s.does)}</div><div class="sub mono">&rarr; ${esc(s.out)}</div></div></div>`).join('');
}
function loadTeam() { renderOrg(); renderCrew(); renderWorkflow(); }

$('#orgTree').addEventListener('click', (e) => {
  const act = e.target.dataset.act, card = e.target.closest('.org-card');
  if (!act || !card || !card.dataset.id) return;
  if (act === 'open') selectAgent(card.dataset.id);
  if (act === 'custom') openCustom('agent', card.dataset.id);
});
$('#crewList').addEventListener('click', (e) => {
  const act = e.target.dataset.act, card = e.target.closest('.crew-card');
  if (!act || !card) return;
  if (act === 'custom') openCustom('preset', card.dataset.preset);
  if (act === 'hire') { $('#btnHire').click(); applyPreset(card.dataset.preset); }
});
$('#teamPick').onclick = async () => { const p = await window.hd.pickFolder(); if (p) $('#teamCwd').value = p; };
$('#teamLaunch').onclick = async () => {
  const brief = $('#teamBrief').value.trim();
  const wanted = [...document.querySelectorAll('#teamRoles input:checked')].map((i) => i.value);
  if (!brief) { toast('Describe what to build first', true); return; }
  const need = wanted.filter((pid) => !agentForPreset(pid)).length;
  if (!confirm(`Start the build?\n\nThis hires and starts ${need} new agent process${need === 1 ? '' : 'es'} (each uses your Claude plan) and sends your brief to ${god() ? god().name : 'the orchestrator'}. Deployments still need your approval.`)) return;
  const r = await window.hd.launchTeam({ brief, cwd: $('#teamCwd').value.trim(), wanted });
  if (!r.ok) { toast(r.error, true); return; }
  $('#teamBrief').value = '';
  toast(r.hired.length ? `Hired ${r.hired.join(', ')}; brief sent to the orchestrator` : 'Brief sent to the orchestrator');
  await refreshAgents();
  loadTeam();
};

// Customize: one dialog for a hired agent (kind "agent") or a crew-library template (kind "preset").
const custom = { kind: '', id: '' };
function openCustom(kind, id) {
  const f = $('#customForm').elements;
  const src = kind === 'agent' ? agentById(id) : (state.presets || {})[id];
  if (!src) return;
  Object.assign(custom, { kind, id });
  $('#customTitle').textContent = `Customize ${src.name}`;
  f.name.value = src.name; f.role.value = src.role || ''; f.model.value = src.model || ''; f.effort.value = src.effort || '';
  f.autonomy.value = src.autonomy || 'edits'; f.instructions.value = src.instructions || '';
  $('#customModelPick').innerHTML = MODELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('#customModelPick').value = MODELS.some(([v]) => v === (src.model || '')) ? (src.model || '') : '';
  let opts;
  if (kind === 'agent') {
    const banned = descendants(id); banned.add(id);
    opts = state.agents.filter((a) => !banned.has(a.id)).map((a) => [a.id, a.isGod ? `${a.name} (orchestrator)` : a.name]);
    $('#customManager').disabled = !!src.isGod;
    $('#customManager').innerHTML = src.isGod ? '<option>You</option>' : opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    if (!src.isGod) $('#customManager').value = managerOf(src) || '';
  } else {
    opts = [['god', 'The orchestrator'], ...Object.values(state.presets).filter((p) => p.id !== id).map((p) => [p.id, p.name])];
    $('#customManager').disabled = false;
    $('#customManager').innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    $('#customManager').value = src.reportsTo || 'god';
  }
  $('#customReset').classList.toggle('hidden', !(kind === 'preset' && src.customized));
  $('#customHint').textContent = kind === 'agent'
    ? 'Model and effort apply live to a running Claude agent. Name, role, manager, autonomy and instructions apply on its next start (Terminal > Start / resume or New session).'
    : 'Applies to future hires from the crew library. Agents already hired are not changed.';
  $('#customDialog').showModal();
}
$('#customModelPick').onchange = (e) => { $('#customModel').value = e.target.value; };
$('#customReset').onclick = async () => {
  const r = await window.hd.resetPreset(custom.id);
  state.presets = r.presets;
  $('#customDialog').close('cancel');
  loadTeam();
  toast('Preset reset to its default');
};
$('#customDialog').addEventListener('close', async () => {
  if ($('#customDialog').returnValue !== 'ok') return;
  const f = $('#customForm').elements;
  const patch = { name: f.name.value, role: f.role.value, model: f.model.value.trim(), effort: f.effort.value, autonomy: f.autonomy.value, instructions: f.instructions.value };
  let r;
  if (custom.kind === 'agent') {
    if (!f.reportsTo.disabled) patch.reportsTo = f.reportsTo.value;
    r = await window.hd.updateAgent(custom.id, patch);
    if (r.ok) toast(r.needsRestart ? 'Saved. Name, role, manager and instructions apply on its next start' : 'Saved');
  } else {
    patch.reportsTo = f.reportsTo.value;
    r = await window.hd.savePreset(custom.id, patch);
    if (r.ok) { state.presets = r.presets; toast('Preset saved for future hires'); }
  }
  if (!r.ok) toast(r.error, true);
  await refreshAgents();
  if (state.tab === 'team') loadTeam();
});

// ---------------- tasks ----------------
const STATUSES = ['todo', 'doing', 'blocked', 'done'];
async function loadTasks() {
  const tasks = await window.hd.tasks();
  $('#kanban').innerHTML = STATUSES.map((st) => `
    <div class="col"><h3>${st} (${tasks.filter((t) => (t.status || 'todo') === st).length})</h3>
      ${tasks.map((t, i) => ({ t, i })).filter(({ t }) => (t.status || 'todo') === st).map(({ t, i }) => `
        <div class="card" data-i="${i}">
          <div class="t">${esc(t.title)}</div>
          ${t.notes ? `<div class="n">${esc(t.notes)}</div>` : ''}
          <div class="row">
            <span class="chip">${esc(t.assignee ? nameOf(t.assignee) : 'unassigned')}</span>
            <select data-field="status">${STATUSES.map((s) => `<option ${s === (t.status || 'todo') ? 'selected' : ''}>${s}</option>`).join('')}</select>
            <button data-act="del" title="Delete">&#10005;</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
}
$('#kanban').addEventListener('change', async (e) => {
  const card = e.target.closest('.card');
  if (!card || e.target.dataset.field !== 'status') return;
  const tasks = await window.hd.tasks();
  tasks[+card.dataset.i].status = e.target.value;
  await window.hd.saveTasks(tasks);
  loadTasks();
});
$('#kanban').addEventListener('click', async (e) => {
  if (e.target.dataset.act !== 'del') return;
  const card = e.target.closest('.card');
  const tasks = await window.hd.tasks();
  tasks.splice(+card.dataset.i, 1);
  await window.hd.saveTasks(tasks);
  loadTasks();
});
$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const tasks = await window.hd.tasks();
  const task = { id: `T-${Date.now().toString(36)}`, title: f.get('title'), status: 'todo', assignee: f.get('assignee') || '', notes: f.get('notes') || '', createdAt: new Date().toISOString() };
  tasks.push(task);
  await window.hd.saveTasks(tasks);
  if (task.assignee) {
    await window.hd.sendMessage({ to: task.assignee, act: 'request', subject: `Task ${task.id}: ${task.title}`, body: `${task.notes || task.title}\n\nThis is task ${task.id} in tasks.json. Set its status to "doing" when you start and "done" when finished, then send me an act:"done" message with the result.` });
  }
  e.target.reset();
  loadTasks();
  toast(task.assignee ? `Task sent to ${nameOf(task.assignee)}` : 'Task added');
});

// ---------------- board ----------------
async function loadBoard() { $('#boardText').value = await window.hd.board(); }
$('#boardReload').onclick = loadBoard;
$('#boardSave').onclick = async () => { await window.hd.saveBoard($('#boardText').value); toast('Board saved'); };

// ---------------- memory ----------------
async function loadMemory() {
  const id = $('#memAgent').value || (state.agents[0] && state.agents[0].id);
  $('#memText').textContent = id ? await window.hd.memory(id) : '';
}
$('#memAgent').onchange = loadMemory;
async function searchMemory() {
  const q = $('#memQuery').value;
  const hits = await window.hd.searchMemory(q);
  $('#memResults').innerHTML = q ? (hits.map((h) => `<div class="mem-hit"><b>${esc(h.name)}</b>:${h.line} ${esc(h.text)}</div>`).join('') || '<div class="hint">No matches.</div>') : '';
}
$('#memSearch').onclick = searchMemory;
$('#memQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMemory(); });

// ---------------- ask me (human inbox) ----------------
async function loadAsk() {
  const msgs = await window.hd.human();
  updateAskBadge(msgs.length);
  $('#askList').innerHTML = msgs.map((m) => `
    <div class="ask" data-file="${esc(m._file)}" data-from="${esc(m.from)}" data-id="${esc(m.id)}" data-conv="${esc(m.conversation)}" data-subject="${esc(m.subject)}">
      <div class="h"><span class="from">${esc(nameOf(m.from))}</span><span class="chip">${esc(m.act)}</span><span class="hint">${esc(time(m.created_at))}</span></div>
      <div><b>${esc(m.subject)}</b></div>
      <div class="body">${esc(m.body)}</div>
      ${m.from !== 'human' ? '<textarea placeholder="Your answer (goes to their inbox)"></textarea>' : ''}
      <div class="row"><button data-act="dismiss">Dismiss</button>${m.from !== 'human' ? '<button class="primary" data-act="reply">Reply</button>' : ''}</div>
    </div>`).join('') || '<div class="empty">Nothing needs you right now.</div>';
}
function updateAskBadge(n) { const b = $('#askBadge'); b.textContent = n; b.classList.toggle('hidden', !n); renderFloor(); }
$('#askList').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const card = e.target.closest('.ask');
  if (!act || !card) return;
  if (act === 'reply') {
    const text = card.querySelector('textarea').value.trim();
    if (!text) { toast('Write an answer first', true); return; }
    await window.hd.sendMessage({ to: card.dataset.from, act: 'inform', subject: `Re: ${card.dataset.subject}`, body: text, in_reply_to: card.dataset.id, conversation: card.dataset.conv });
    toast(`Answer sent to ${nameOf(card.dataset.from)}`);
  }
  await window.hd.humanDone(card.dataset.file);
  loadAsk();
});

// ---------------- log + activity ----------------
function describe(ev) {
  switch (ev.type) {
    case 'message': return `<b>${esc(nameOf(ev.from))}</b> &rarr; <b>${esc((ev.to || []).map(nameOf).join(', '))}</b> [${esc(ev.act)}] ${esc(ev.subject)}${ev.escalated ? ' (escalated)' : ''}`;
    case 'agent-hired': return `Hired <b>${esc(ev.name)}</b> (${esc(ev.provider)})`;
    case 'agent-started': return `<b>${esc(nameOf(ev.agent))}</b> ${ev.resume ? 'resumed' : 'started'}`;
    case 'agent-exited': return `<b>${esc(nameOf(ev.agent))}</b> exited (code ${esc(ev.code)})`;
    case 'agent-woken': return `Woke <b>${esc(nameOf(ev.agent))}</b> for ${esc(ev.messages)} message(s)`;
    case 'stop-blocked': return `<b>${esc(nameOf(ev.agent))}</b> kept working: ${esc(ev.messages)} new message(s)`;
    case 'agent-configured': return `<b>${esc(nameOf(ev.agent))}</b> switched to ${esc([ev.model, ev.effort && ev.effort + ' effort'].filter(Boolean).join(', ') || 'defaults')}`;
    case 'agent-archived': return `Archived <b>${esc(nameOf(ev.agent))}</b>`;
    case 'spawn-request-done': return `God spawned a worker (${esc(ev.file)})`;
    case 'spawn-request-failed': return `Spawn request failed: ${esc(ev.reason)}`;
    case 'bad-message': return `Unreadable message from <b>${esc(nameOf(ev.agent))}</b>: ${esc(ev.error)}`;
    case 'app-start': return `App started (v${esc(ev.version)})`;
    default: return esc(ev.type);
  }
}
function addActivity(ev) {
  const el = document.createElement('div');
  const who = ev.from || ev.agent || '';
  el.className = 'act';
  el.innerHTML = `<div class="avatar sm ${who === 'human' ? 'you' : ''}" style="--c:${who && who !== 'human' ? colorFor(who) : '#8e8e93'}">${who ? esc(initials(nameOf(who))) : '·'}</div>
    <div><div class="what">${describe(ev)}</div><div class="when mono">${esc(time(ev.ts))}</div></div>`;
  const box = $('#activity');
  box.prepend(el);
  while (box.children.length > 200) box.lastChild.remove();
}
async function loadLog() {
  const evs = await window.hd.log(400);
  $('#logList').innerHTML = evs.reverse().map((ev) => `<div class="log-row"><span class="ts">${esc(time(ev.ts))}</span><span class="ty">${esc(ev.type)}</span><span>${describe(ev)}</span></div>`).join('');
}

// ---------------- brief the orchestrator ----------------
async function sendBrief() {
  const text = $('#briefText').value.trim();
  const g = god();
  if (!text) return;
  if (!g) { toast('No orchestrator. Hire one or enable it in Settings.', true); return; }
  if ($('#briefAsMessage').checked || !RUNNING.includes(g.status)) {
    await window.hd.sendMessage({ to: g.id, act: 'request', subject: text.split('\n')[0].slice(0, 80), body: text });
    toast(`Sent to ${g.name}'s inbox`);
  } else {
    await window.hd.typeTo(g.id, text.replace(/\s*\n\s*/g, ' '));
    toast(`Briefed ${g.name}`);
  }
  $('#briefText').value = '';
}
$('#briefSend').onclick = sendBrief;
$('#briefText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) sendBrief(); });

// ---------------- hire + settings dialogs ----------------
function providerOptions(sel, current) {
  sel.innerHTML = Object.entries(state.providers).map(([k, v]) => `<option value="${k}" ${k === current ? 'selected' : ''}>${esc(v.label)}${v.installed ? '' : ' (not found)'}</option>`).join('');
}
function applyPreset(pid) {
  const p = (state.presets || {})[pid];
  if (!p) return;
  const f = $('#hireForm').elements;
  const boss = p.reportsTo && p.reportsTo !== 'god' ? agentForPreset(p.reportsTo) : null;
  f.name.value = p.name;
  f.role.value = p.role; f.provider.value = p.provider; f.model.value = p.model; f.effort.value = p.effort;
  f.autonomy.value = p.autonomy; f.instructions.value = p.instructions;
  f.presetId.value = p.id; f.lead.value = p.lead ? '1' : ''; f.reportsTo.value = boss ? boss.id : (god() ? god().id : '');
  $('#hireCommandRow').classList.toggle('hidden', p.provider !== 'custom');
}
$('#hirePresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (b) applyPreset(b.dataset.preset);
});
$('#btnHire').onclick = () => {
  $('#hireForm').reset();
  $('#hirePresets').innerHTML = Object.entries(state.presets || {}).map(([k, v]) => `<button type="button" data-preset="${esc(k)}" title="${esc(v.role)}">+ ${esc(v.name)}</button>`).join('');
  providerOptions($('#hireProvider'), 'claude');
  $('#hireCommandRow').classList.add('hidden');
  $('#hireDialog').showModal();
};
$('#btnHire2').onclick = () => $('#btnHire').click();
$('#hireProvider').onchange = (e) => $('#hireCommandRow').classList.toggle('hidden', e.target.value !== 'custom');
$('#hirePick').onclick = async () => { const p = await window.hd.pickFolder(); if (p) $('#hireCwd').value = p; };
$('#hireDialog').addEventListener('close', async () => {
  if ($('#hireDialog').returnValue !== 'ok') return;
  const input = Object.fromEntries(new FormData($('#hireForm')).entries());
  const r = await window.hd.createAgent(input);
  if (!r.ok) toast(r.error || 'Could not start the agent', true);
  await refreshAgents();
  selectAgent(r.agent.id);
});

$('#btnSettings').onclick = () => {
  const f = $('#settingsForm');
  providerOptions($('#setGodProvider'), state.settings.godProvider);
  for (const [k, v] of Object.entries(state.settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  $('#settingsDialog').showModal();
};
$('#setPick').onclick = async () => { const p = await window.hd.pickFolder(); if (p) $('#setWorkspace').value = p; };
$('#settingsDialog').addEventListener('close', async () => {
  if ($('#settingsDialog').returnValue !== 'ok') return;
  const next = {};
  for (const el of $('#settingsForm').elements) if (el.name) next[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  const r = await window.hd.saveSettings(next);
  if (r.reloaded) {
    for (const t of terms.values()) { t.term.dispose(); t.host.remove(); }
    terms.clear();
    state.selected = null;
  }
  await init();
  toast(r.reloaded ? 'Workspace switched' : 'Settings saved');
});
$('#btnOpenHive').onclick = () => window.hd.openPath(state.hiveRoot);

// ---------------- live events ----------------
window.hd.onData((id, d) => {
  const e = terms.get(id);
  if (!e) return;
  if (e.ready) e.term.write(d); else e.pending.push(d);
});
window.hd.onStatus((id, info) => {
  const a = agentById(id);
  if (!a) { refreshAgents(); return; }
  Object.assign(a, info);
  renderAgents();
});
window.hd.onTool((id, tool) => { const a = agentById(id); if (a) { a.lastTool = tool; renderAgents(); } });
window.hd.onMessage((m) => {
  if (m.to !== 'human') { const a = agentById(m.to); if (a) a.unread = (a.unread || 0) + 1; }
  renderAgents();
  window.Office.envelope(m.from, m.to);
});
window.hd.onLog((ev) => {
  addActivity(ev);
  if (state.tab === 'log') loadLog();
  if (ev.type === 'agent-hired' || ev.type === 'agent-archived') refreshAgents();
});
window.hd.onHuman(() => {
  if (state.tab === 'ask') loadAsk(); else window.hd.human().then((m) => updateAskBadge(m.length));
  toast('An agent needs you (Ask me)');
});
window.hd.onAgentsChanged(refreshAgents);

// Unread counts change when agents move files to .done/: refresh periodically.
setInterval(async () => {
  state.agents = await window.hd.agents();
  renderAgents();
  if (state.tab === 'tasks' && !(document.activeElement && document.activeElement.closest('#kanban, #taskForm'))) loadTasks();
}, 4000);

async function init() {
  const s = await window.hd.state();
  Object.assign(state, { settings: s.settings, providers: s.providers, agents: s.agents, hiveRoot: s.hiveRoot, presets: s.presets, productionTeam: s.productionTeam, workflow: s.workflow });
  $('#workspace').textContent = s.hiveRoot;
  if (!state.selected && god()) state.selected = god().id;
  renderAgents();
  $('#activity').innerHTML = '';
  (await window.hd.log(60)).forEach(addActivity);
  updateAskBadge((await window.hd.human()).length);
  renderFloor();
  window.Office.setActive(state.tab === 'floor');
}
init();
