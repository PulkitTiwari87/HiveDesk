'use strict';
// Electron main process: owns the hive, the agents, the hook server, the
// router loop and the single git committer. The renderer only talks via IPC.

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Hive, readJson, writeJson } = require('./hive');
const { AgentManager, PROVIDERS, resolveCommand } = require('./agents');
const { Mirror } = require('./mirror');
const { mergedPresets, planTeam, PRODUCTION_TEAM, WORKFLOW, PLAYBOOK } = require('./presets');
const mirror = new Mirror();

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = {
  workspace: path.join(app.getPath('documents'), 'Hivedesk'),
  autoGod: true,
  godName: 'Orion',
  godProvider: 'claude',
  godAutonomy: 'edits',
  godModel: '',
  restoreAgents: true,
  gitCommit: true,
  presetOverrides: {}, // { <presetId>: { name, role, model, effort, autonomy, instructions, reportsTo } }
};
let settings = { ...DEFAULT_SETTINGS, ...readJson(settingsFile(), {}) };
if (process.env.HIVEDESK_WORKSPACE) settings.workspace = process.env.HIVEDESK_WORKSPACE; // used by tests

let win = null;
let hive = null;
let agents = null;
let hookServer = null;
let hookPort = 0;
const hookToken = crypto.randomBytes(16).toString('hex');
const timers = [];

function send(channel, ...args) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try { win.webContents.send(channel, ...args); } catch { /* window is closing */ }
}

// ---------------- single git committer ----------------
let gitAvailable = null;
let commitTimer = null;
let committing = Promise.resolve();
function git(args) {
  const cwd = hive.root;
  return new Promise((resolve) => execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') })));
}
async function gitInit() {
  if (!settings.gitCommit) return;
  gitAvailable = await new Promise((r) => execFile('git', ['--version'], { windowsHide: true }, (e) => r(!e)));
  if (!gitAvailable) return;
  if (!fs.existsSync(path.join(hive.root, '.git'))) {
    await git(['init', '-q']);
    await git(['config', 'user.name', 'Hivedesk']);
    await git(['config', 'user.email', 'hive@hivedesk.local']);
  }
}
function scheduleCommit(reason) {
  if (!settings.gitCommit || !gitAvailable) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    committing = committing.then(async () => {
      await git(['add', '-A']);
      await git(['commit', '-q', '-m', reason || 'hive update']);
    });
  }, 3000);
}

// ---------------- hook server (Claude Code hooks -> harness) ----------------
function startHookServer() {
  return new Promise((resolve) => {
    hookServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const m = url.pathname.match(/^\/hook\/([a-z0-9-]+)$/);
      if (req.method !== 'POST' || !m || url.searchParams.get('t') !== hookToken) { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch {}
        let out = {};
        try { out = agents.onHook(m[1], payload) || {}; } catch (e) { console.error('hook', e); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    hookServer.listen(0, '127.0.0.1', () => { hookPort = hookServer.address().port; resolve(); });
  });
}
const hookUrl = (id) => `http://127.0.0.1:${hookPort}/hook/${id}?t=${hookToken}`;

// ---------------- hive bootstrap ----------------
function agentView(a) {
  return { ...a, ...agents.info(a.id), unread: hive.unread(a.id).length };
}

function ensureGod() {
  if (!settings.autoGod || hive.god()) return;
  hive.addAgent({
    id: 'orion',
    name: settings.godName || 'Orion',
    role: 'Orchestrator and manager. Runs the team, delegates work, tracks tasks, reports to the human.',
    provider: settings.godProvider,
    autonomy: settings.godAutonomy,
    model: settings.godModel,
    cwd: settings.workspace,
    isGod: true,
  });
}

function boot() {
  fs.mkdirSync(settings.workspace, { recursive: true });
  hive = new Hive(path.join(settings.workspace, 'hive'));
  hive.init();
  hive.onLog = (ev) => send('hive:log', ev);
  agents = new AgentManager({ hive, hookUrl, workspace: settings.workspace });
  agents.on('data', (id, d) => send('pty:data', id, d));
  agents.on('status', (id, info) => {
    send('agent:status', id, info);
    if (info.status === 'idle') setTimeout(() => agents.maybeWake(id), 300);
  });
  agents.on('tool', (id, tool) => send('agent:tool', id, tool));
  hive.log({ type: 'app-start', version: app.getVersion() });
  gitInit().then(() => scheduleCommit('app start'));
  ensureGod();
  const toStart = settings.restoreAgents ? hive.agents() : hive.agents().filter((a) => a.isGod);
  for (const a of toStart) agents.start(a, { resume: true });
  timers.push(setInterval(routerTick, 1000));
  timers.push(setInterval(spawnTick, 2000));
}

function shutdownHive() {
  timers.splice(0).forEach(clearInterval);
  if (agents) agents.stopAll();
}

// Router: drain outboxes, deliver, animate, wake recipients.
function routerTick() {
  let deliveries = [];
  try { deliveries = hive.routeOnce(); } catch (e) { console.error('router', e); }
  if (!deliveries.length) return;
  for (const { msg, to } of deliveries) {
    send('hive:message', { id: msg.id, from: msg.from, to, act: msg.act, subject: msg.subject });
    if (to === 'human') send('human:new', msg);
    else agents.maybeWake(to);
  }
  scheduleCommit(`route ${deliveries.length} message(s)`);
}

// Spawn requests written by god.
function spawnTick() {
  for (const { file, req } of hive.takeSpawnRequests()) {
    if (!req.objective) { hive.finishSpawnRequest(file, false, 'missing "objective"'); continue; }
    const meta = hive.addAgent({
      name: req.name || `Worker ${hive.agents().length}`,
      role: req.role || String(req.objective).slice(0, 120),
      provider: PROVIDERS[req.provider] ? req.provider : 'claude',
      model: req.model || '',
      autonomy: req.autonomy || 'edits',
      cwd: req.cwd || settings.workspace,
      command: req.command || '',
      reportsTo: req.reportsTo, // validated by the hive: unknown or looping managers fall back to god
    });
    const g = hive.god();
    hive.send({ to: meta.id, act: 'request', subject: 'Your assignment', body: String(req.objective) }, g ? g.id : 'human');
    const r = agents.start(meta);
    hive.finishSpawnRequest(file, r.ok, r.error);
    send('agents:changed');
    scheduleCommit(`spawn ${meta.id}`);
  }
}

// ---------------- window ----------------
function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1000, minHeight: 640,
    backgroundColor: '#14161c',
    title: 'Hivedesk',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Opt-in visual check: HIVEDESK_SCREENSHOT=<file.png> captures the window and quits.
  if (process.env.HIVEDESK_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.HIVEDESK_TAB) await win.webContents.executeJavaScript(`document.querySelector('#tabs [data-tab="${process.env.HIVEDESK_TAB}"]').click()`).catch(() => {});
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.HIVEDESK_SCREENSHOT, img.toPNG());
        app.quit();
      }, 1500);
    }, Number(process.env.HIVEDESK_SCREENSHOT_DELAY || 6000)));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('state:get', () => ({
    settings,
    hiveRoot: hive.root,
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, installed: k === 'custom' || !!resolveCommand(v.bin) }])),
    agents: hive.agents().map(agentView),
    presets: mergedPresets(settings.presetOverrides),
    productionTeam: PRODUCTION_TEAM,
    workflow: WORKFLOW,
    git: gitAvailable,
  }));
  // Rename / re-role / re-model / re-manage a hired agent. Model and effort apply live (Claude); the rest on the next start.
  ipcMain.handle('agent:update', (_e, id, p = {}) => {
    const a = hive.getAgent(id);
    if (!a || a.archived) return { ok: false, error: 'unknown agent' };
    const patch = {};
    if (p.name !== undefined) {
      const n = String(p.name).trim().slice(0, 40);
      if (!n) return { ok: false, error: 'Name cannot be empty.' };
      patch.name = n;
    }
    if (p.role !== undefined) patch.role = String(p.role).trim().slice(0, 300);
    if (p.instructions !== undefined) patch.instructions = String(p.instructions).slice(0, 20000);
    if (p.autonomy !== undefined) {
      if (!['ask', 'edits', 'full'].includes(p.autonomy)) return { ok: false, error: 'Autonomy must be ask, edits or full.' };
      patch.autonomy = p.autonomy;
    }
    if (p.reportsTo !== undefined) {
      const err = hive.setManager(id, p.reportsTo || (hive.god() || {}).id);
      if (err) return { ok: false, error: err };
    }
    const r = agents.configure(id, { model: p.model, effort: p.effort }); // validates, saves, applies live when it can
    if (!r.ok) return r;
    if (Object.keys(patch).length) hive.updateAgent(id, patch);
    hive.log({ type: 'agent-updated', agent: id, fields: Object.keys({ ...patch, ...(p.reportsTo !== undefined ? { reportsTo: 1 } : {}) }) });
    send('agents:changed');
    scheduleCommit(`update ${id}`);
    const restart = !!(patch.name || patch.role || patch.instructions || patch.autonomy || p.reportsTo !== undefined);
    return { ok: true, applied: r.applied, needsRestart: restart && agents.info(id).status !== 'stopped' };
  });
  // Edit a preset template (kept in settings, so it survives restarts and applies to future hires).
  ipcMain.handle('preset:save', (_e, id, p = {}) => {
    const base = mergedPresets({})[id];
    if (!base) return { ok: false, error: 'unknown preset' };
    const o = {};
    for (const k of ['name', 'role', 'model', 'effort', 'autonomy', 'instructions', 'reportsTo']) if (typeof p[k] === 'string') o[k] = p[k];
    if (!String(o.name ?? base.name).trim()) return { ok: false, error: 'Name cannot be empty.' };
    settings.presetOverrides = { ...settings.presetOverrides, [id]: o };
    writeJson(settingsFile(), settings);
    return { ok: true, presets: mergedPresets(settings.presetOverrides) };
  });
  ipcMain.handle('preset:reset', (_e, id) => {
    const rest = { ...settings.presetOverrides };
    delete rest[id];
    settings.presetOverrides = rest;
    writeJson(settingsFile(), settings);
    return { ok: true, presets: mergedPresets(settings.presetOverrides) };
  });
  // "Build software": hire the missing production leads under the orchestrator, then hand it the brief + playbook.
  ipcMain.handle('team:launch', (_e, { brief, cwd, wanted } = {}) => {
    const g = hive.god();
    if (!g) return { ok: false, error: 'No orchestrator. Enable it in Settings first.' };
    if (!String(brief || '').trim()) return { ok: false, error: 'Describe what to build first.' };
    const presets = mergedPresets(settings.presetOverrides);
    const wantList = (Array.isArray(wanted) && wanted.length ? wanted : PRODUCTION_TEAM).filter((x) => presets[x]);
    const dir = cwd || settings.workspace;
    const idOf = new Map(hive.agents().filter((a) => a.presetId).map((a) => [a.presetId, a.id]));
    const hired = [];
    for (const h of planTeam(hive.agents(), presets, wantList)) {
      const p = presets[h.presetId];
      let mgr = h.reportsTo;
      if (String(mgr).startsWith('preset:')) mgr = idOf.get(mgr.slice(7)) || g.id; // manager not in this batch: report to the orchestrator
      const { id: _templateId, ...tpl } = p; // never reuse the template id: addAgent would overwrite an archived agent with it
      const meta = hive.addAgent({ ...tpl, presetId: h.presetId, reportsTo: mgr, cwd: dir });
      idOf.set(h.presetId, meta.id);
      agents.start(meta);
      hired.push(meta.name);
    }
    for (const a of hive.agents()) if (a.presetId && wantList.includes(a.presetId) && a.cwd !== dir && !hired.includes(a.name)) hive.updateAgent(a.id, { cwd: dir });
    const roster = wantList.map((pid) => idOf.get(pid)).filter(Boolean).map((id) => hive.getAgent(id)).map((a) => `- ${a.id} (${a.name}): ${a.role}; reports to ${(hive.manager(a.id) || {}).id || 'you'}`).join('\n');
    const body = `${String(brief).trim()}\n\nProject folder: ${dir}\n\nYour team (employees, already hired and running):\n${roster}\n\n${PLAYBOOK}`;
    hive.send({ to: g.id, act: 'request', subject: `Build: ${String(brief).trim().split('\n')[0].slice(0, 70)}`, body }, 'human');
    agents.maybeWake(g.id);
    send('agents:changed');
    scheduleCommit('launch team');
    return { ok: true, hired };
  });
  ipcMain.handle('agent:configure', (_e, id, patch) => {
    const r = agents.configure(id, patch || {});
    if (r.ok) send('agents:changed');
    return r;
  });
  // Claude Code chats started anywhere (CLI, desktop app, IDE), read from its own transcripts. Hivedesk's own agents are excluded.
  ipcMain.handle('mirror:list', () => mirror.list(new Set(hive.agents({ includeArchived: true }).map((a) => a.sessionId))));
  ipcMain.handle('mirror:read', (_e, id, limit) => mirror.read(id, Math.min(Number(limit) || 200, 500)));
  ipcMain.handle('agents:list', () => hive.agents().map(agentView));
  ipcMain.handle('agent:create', (_e, input) => {
    const meta = hive.addAgent({ ...input, isGod: false });
    const r = agents.start(meta);
    if (input.objective) hive.send({ to: meta.id, act: 'request', subject: 'Your first task', body: input.objective }, 'human');
    scheduleCommit(`hire ${meta.id}`);
    return { ...r, agent: agentView(meta) };
  });
  ipcMain.handle('agent:start', (_e, id) => {
    const a = hive.getAgent(id);
    return a ? agents.start(a, { resume: true }) : { ok: false, error: 'unknown agent' };
  });
  ipcMain.handle('agent:fresh', (_e, id) => {
    if (!hive.getAgent(id)) return { ok: false, error: 'unknown agent' };
    agents.stop(id);
    const meta = hive.updateAgent(id, { sessionId: crypto.randomUUID(), started: false });
    return agents.start(meta);
  });
  ipcMain.handle('agent:stop', (_e, id) => { agents.stop(id); return { ok: true }; });
  ipcMain.handle('agent:remove', (_e, id) => {
    agents.forget(id);
    hive.archiveAgent(id);
    scheduleCommit(`archive ${id}`);
    return { ok: true };
  });
  ipcMain.handle('agent:type', (_e, id, text) => agents.type(id, text));
  ipcMain.on('pty:write', (_e, id, data) => agents.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => agents.resize(id, cols, rows));
  ipcMain.handle('pty:replay', (_e, id) => agents.replay(id));

  ipcMain.handle('hive:send', (_e, msg) => {
    const d = hive.send(msg, 'human');
    d.forEach(({ msg: m, to }) => {
      send('hive:message', { id: m.id, from: 'human', to, act: m.act, subject: m.subject });
      if (to !== 'human') agents.maybeWake(to);
    });
    scheduleCommit('human message');
    return d.length;
  });
  ipcMain.handle('hive:tasks', () => hive.tasks());
  ipcMain.handle('hive:saveTasks', (_e, t) => { hive.saveTasks(t); scheduleCommit('tasks'); return true; });
  ipcMain.handle('hive:board', () => hive.board());
  ipcMain.handle('hive:saveBoard', (_e, t) => { hive.saveBoard(t); scheduleCommit('board'); return true; });
  ipcMain.handle('hive:log', (_e, n) => hive.readLog(n || 300));
  ipcMain.handle('hive:memory', (_e, id) => hive.memory(id));
  ipcMain.handle('hive:searchMemory', (_e, q) => hive.searchMemory(q));
  ipcMain.handle('hive:human', () => hive.unread('human'));
  ipcMain.handle('hive:humanDone', (_e, file) => hive.markDone('human', file));
  ipcMain.handle('open:path', (_e, p) => shell.openPath(p || hive.root));
  ipcMain.handle('pick:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('settings:save', (_e, next) => {
    const workspaceChanged = !!next.workspace && next.workspace !== settings.workspace;
    settings = { ...settings, ...next };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    writeJson(settingsFile(), settings);
    if (workspaceChanged) { shutdownHive(); boot(); }
    return { ok: true, reloaded: workspaceChanged };
  });
}

// ---------------- lifecycle ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    await startHookServer();
    boot();
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    shutdownHive();
    clearTimeout(commitTimer);
    if (hookServer) hookServer.close();
  });
}
