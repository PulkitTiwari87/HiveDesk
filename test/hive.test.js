'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Hive, HOP_CAP } = require('../src/main/hive');
const { AgentManager, resolveCommand } = require('../src/main/agents');

function freshHive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-hive-'));
  const hive = new Hive(root);
  hive.init();
  return hive;
}
function outbox(hive, id, name, obj) {
  fs.writeFileSync(path.join(hive.agentDir(id), 'outbox', name), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

test('init creates the hive layout', () => {
  const hive = freshHive();
  for (const f of ['PROTOCOL.md', 'registry.json', 'tasks.json', 'board.md', 'log.jsonl', 'spawn-requests/.done', 'human/inbox/.done']) {
    assert.ok(fs.existsSync(hive.p(f)), f);
  }
});

test('addAgent creates files and unique ids', () => {
  const hive = freshHive();
  const a = hive.addAgent({ name: 'Pam' });
  const b = hive.addAgent({ name: 'Pam' });
  assert.equal(a.id, 'pam');
  assert.equal(b.id, 'pam-2');
  for (const f of ['identity.md', 'memory.md', 'inbox/.done', 'outbox']) assert.ok(fs.existsSync(path.join(hive.agentDir('pam'), f)));
  assert.equal(hive.addAgent({ name: 'God' }).id, 'god-2', 'reserved ids are skipped');
});

test('router delivers by id, name, god alias and broadcast', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  hive.addAgent({ name: 'Pam' });
  hive.addAgent({ name: 'Jim' });
  outbox(hive, 'pam', '1.json', { to: 'jim', act: 'request', subject: 'hi', body: 'b' });
  outbox(hive, 'jim', '2.json', { to: 'Pam', act: 'inform', subject: 'by name' });
  outbox(hive, 'jim', '3.json', { to: 'god', act: 'query', subject: 'to god' });
  outbox(hive, 'orion', '4.json', { to: 'broadcast', act: 'inform', subject: 'all hands' });
  const d = hive.routeOnce();
  assert.equal(d.length, 5);
  assert.equal(hive.unread('jim').length, 2);
  assert.equal(hive.unread('pam').length, 2);
  assert.equal(hive.unread('orion').length, 1);
  const m = hive.unread('jim').find((x) => x.subject === 'hi');
  assert.equal(m.from, 'pam');
  assert.equal(m.requires_reply, true);
  assert.equal(fs.readdirSync(path.join(hive.agentDir('pam'), 'outbox')).filter((f) => f.endsWith('.json')).length, 0);
});

test('sender cannot spoof from; unknown recipient bounces to god', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  hive.addAgent({ name: 'Pam' });
  outbox(hive, 'pam', 'x.json', { to: 'nobody', from: 'orion', subject: 'lost' });
  hive.routeOnce();
  const [m] = hive.unread('orion');
  assert.equal(m.from, 'pam');
  assert.match(m.subject, /undeliverable to "nobody"/);
});

test('to:human lands in the human inbox and can be marked done', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  outbox(hive, 'pam', 'h.json', { to: 'human', act: 'query', subject: 'need a decision' });
  hive.routeOnce();
  const msgs = hive.unread('human');
  assert.equal(msgs.length, 1);
  assert.ok(hive.markDone('human', msgs[0]._file));
  assert.equal(hive.unread('human').length, 0);
});

test('replies increment hops and runaway threads escalate to the human', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  hive.addAgent({ name: 'Jim' });
  let [{ msg }] = hive.send({ to: 'jim', act: 'request', subject: 'ping' }, 'pam');
  assert.equal(msg.hops, 0);
  let last = msg;
  for (let i = 1; i <= HOP_CAP; i++) {
    const from = i % 2 ? 'jim' : 'pam';
    const to = i % 2 ? 'pam' : 'jim';
    [{ msg }] = hive.send({ to, act: 'request', subject: 'pong', in_reply_to: last.id, hops: 0 }, from);
    assert.equal(msg.hops, i);
    last = msg;
  }
  const d = hive.send({ to: 'pam', act: 'request', subject: 'too far', in_reply_to: last.id }, 'jim');
  assert.equal(d[0].to, 'human');
  assert.equal(d[0].msg.needs_human, true);
});

test('half-written outbox file is retried, not dropped', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  outbox(hive, 'pam', 'partial.json', '{"to": "hu');
  assert.equal(hive.routeOnce().length, 0);
  assert.ok(fs.existsSync(path.join(hive.agentDir('pam'), 'outbox', 'partial.json')));
});

test('spawn requests are picked up and archived', () => {
  const hive = freshHive();
  fs.writeFileSync(hive.p('spawn-requests', 'a.json'), JSON.stringify({ name: 'Dwight', objective: 'sell paper' }));
  const reqs = hive.takeSpawnRequests();
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].req.name, 'Dwight');
  hive.finishSpawnRequest('a.json', true);
  assert.ok(fs.existsSync(hive.p('spawn-requests', '.done', 'a.json')));
});

test('god prompt carries orchestration duties; worker prompt does not', () => {
  const hive = freshHive();
  const g = hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const p = hive.addAgent({ name: 'Pam', role: 'designer' });
  assert.match(hive.prompt(g), /GOD \/ ORCHESTRATOR/);
  assert.doesNotMatch(hive.prompt(p), /GOD \/ ORCHESTRATOR/);
  assert.match(hive.prompt(p), /outbox/);
});

test('memory search finds lines across agents', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  fs.appendFileSync(path.join(hive.agentDir('pam'), 'memory.md'), '- the API key lives in .env.local\n');
  const hits = hive.searchMemory('api key');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].agent, 'pam');
});

// ---------------- AgentManager without a real PTY ----------------
function managerWithFakeSession(hive, id) {
  const m = new AgentManager({ hive, hookUrl: () => 'http://x', workspace: hive.root });
  const writes = [];
  m.sessions.set(id, { proc: { write: (d) => writes.push(d), pid: 1 }, buf: '', status: 'idle', lastTool: '', notified: new Set(), hooks: true, plain: false, typedPrompt: null, lastWake: 0 });
  return { m, writes };
}

test('Stop hook blocks once while there is new mail, then lets the agent stop', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  hive.addAgent({ name: 'Jim' });
  const { m } = managerWithFakeSession(hive, 'pam');
  assert.deepEqual(m.onHook('pam', { hook_event_name: 'Stop' }), {});
  hive.send({ to: 'pam', act: 'request', subject: 'review my PR' }, 'jim');
  const r = m.onHook('pam', { hook_event_name: 'Stop' });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /review my PR/);
  assert.deepEqual(m.onHook('pam', { hook_event_name: 'Stop' }), {}, 'same mail is not announced twice');
  hive.send({ to: 'pam', act: 'request', subject: 'second' }, 'jim');
  assert.deepEqual(m.onHook('pam', { hook_event_name: 'Stop', stop_hook_active: true }), {}, 'stop_hook_active guards loops');
  assert.equal(m.info('pam').status, 'idle');
});

test('idle agent with new mail is woken by typing into its terminal once', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  const { m, writes } = managerWithFakeSession(hive, 'pam');
  hive.send({ to: 'pam', act: 'request', subject: 'wake up' }, 'human');
  assert.equal(m.maybeWake('pam'), true);
  assert.match(writes[0], /wake up/);
  m.sessions.get('pam').status = 'idle';
  m.sessions.get('pam').lastWake = 0;
  assert.equal(m.maybeWake('pam'), false, 'already notified');
});

test('a startup menu (trust / update) marks the agent as needing the human and blocks typing', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam', provider: 'codex' });
  const { m, writes } = managerWithFakeSession(hive, 'pam');
  const s = m.sessions.get('pam');
  Object.assign(s, { hooks: false, status: 'starting', sinceInput: '', hookSeen: false });
  s.buf = s.sinceInput = '\x1b[1m› 1. Update now (runs `npm install -g @openai/codex`)\x1b[0m 2. Skip  Press enter to continue';
  m.onActivity('pam', s);
  assert.equal(m.info('pam').status, 'waiting');
  hive.send({ to: 'pam', act: 'request', subject: 'do work' }, 'human');
  assert.equal(m.maybeWake('pam'), false, 'never type into a menu');
  assert.equal(writes.length, 0);
  m.write('pam', '2');
  assert.equal(s.sinceInput, '', 'human input clears the menu detection');
  clearTimeout(s.quietTimer);
});

test('PreToolUse / Notification hooks drive status', () => {
  const hive = freshHive();
  hive.addAgent({ name: 'Pam' });
  const { m } = managerWithFakeSession(hive, 'pam');
  m.onHook('pam', { hook_event_name: 'PreToolUse', tool_name: 'Edit' });
  assert.deepEqual([m.info('pam').status, m.info('pam').lastTool], ['working', 'Edit']);
  m.onHook('pam', { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  assert.equal(m.info('pam').status, 'waiting');
  assert.equal(m.info('pam').ask, 'Claude needs your permission to use Bash', 'the office shows the real request');
  m.onHook('pam', { hook_event_name: 'PostToolUse' });
  assert.deepEqual([m.info('pam').status, m.info('pam').ask], ['working', ''], 'the request clears once the agent moves on');
});

test('claude launch spec injects prompt, hooks, hive dir and session id', { skip: !resolveCommand('claude') && 'claude not installed' }, () => {
  const hive = freshHive();
  const meta = hive.addAgent({ name: 'Pam', provider: 'claude', autonomy: 'edits' });
  const m = new AgentManager({ hive, hookUrl: (id) => `http://127.0.0.1:1/hook/${id}?t=x`, workspace: hive.root });
  const spec = m.launchSpec(meta, { resume: false });
  const a = spec.args;
  assert.ok(a.includes('--append-system-prompt'));
  assert.equal(a[a.indexOf('--session-id') + 1], meta.sessionId);
  assert.equal(a[a.indexOf('--add-dir') + 1], hive.root);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');
  const settings = JSON.parse(fs.readFileSync(a[a.indexOf('--settings') + 1], 'utf8'));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /curl .*\/hook\/pam\?t=x/);
  assert.equal(spec.env.AGENT_ID, 'pam');
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || 'x';
  const env2 = m.launchSpec(meta, { resume: false }).env;
  assert.equal(env2.CLAUDE_CODE_CHILD_SESSION, undefined, 'parent session markers are stripped');
  assert.ok(env2.CLAUDE_CONFIG_DIR, 'real config is kept');
  const resumed = m.launchSpec({ ...meta, started: true }, { resume: true }).args;
  assert.equal(resumed[resumed.indexOf('--resume') + 1], meta.sessionId);
});

test('custom command keeps quoted paths and arguments intact', { skip: process.platform !== 'win32' && 'cmd quoting is Windows-specific' }, async () => {
  const hive = freshHive();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd quoted-'));
  const script = path.join(dir, 'hello.js');
  fs.writeFileSync(script, 'console.log("CUSTOM_OK " + process.argv.slice(2).join("|")); setTimeout(() => {}, 500);');
  const meta = hive.addAgent({ name: 'Cleo', provider: 'custom', command: `node "${script}" "two words"`, cwd: dir });
  const m = new AgentManager({ hive, hookUrl: () => 'http://127.0.0.1:1/x', workspace: dir });
  assert.ok(m.start(meta).ok);
  const t0 = Date.now();
  while (!/CUSTOM_OK/.test(m.replay('cleo')) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
  m.stopAll();
  assert.match(m.replay('cleo'), /CUSTOM_OK two words/, 'quotes survive: the script path (with a space) and the quoted argument arrive whole');
});

test('Designer preset: standing instructions reach the system prompt', () => {
  const { PRESETS } = require('../src/main/presets');
  const hive = freshHive();
  const meta = hive.addAgent({ ...PRESETS.designer });
  assert.equal(meta.id, 'designer');
  assert.equal(meta.effort, 'high');
  const p = hive.prompt(meta);
  assert.match(p, /HEAD DESIGNER/);
  assert.match(p, /"apple-design"/);
  assert.match(p, /"impeccable"/);
  assert.ok(!/STANDING INSTRUCTIONS/.test(hive.prompt(hive.addAgent({ name: 'Plain' }))), 'agents without instructions are unchanged');
});

test('hierarchy: reportsTo defaults to god, survives addAgent, rejects self and loops', () => {
  const hive = freshHive();
  const g = hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const a = hive.addAgent({ name: 'Lead' });
  const b = hive.addAgent({ name: 'Worker', reportsTo: a.id });
  assert.equal(g.reportsTo, null);
  assert.equal(a.reportsTo, 'orion');
  assert.equal(hive.getAgent(b.id).reportsTo, a.id);
  assert.equal(hive.addAgent({ name: 'Ghost', reportsTo: 'nobody' }).reportsTo, 'orion', 'unknown manager falls back to god');
  assert.match(hive.setManager(a.id, a.id), /itself/);
  assert.match(hive.setManager(a.id, b.id), /loop/, 'a manager cannot report to their own employee');
  assert.match(hive.setManager('orion', a.id), /reports to you/);
  assert.equal(hive.setManager(b.id, 'orion'), null);
  assert.equal(hive.getAgent(b.id).reportsTo, 'orion');
});

test('hierarchy: archiving a manager moves employees up; prompt names manager and reports', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const lead = hive.addAgent({ name: 'Lead', lead: true });
  const emp = hive.addAgent({ name: 'Emp', reportsTo: lead.id });
  assert.match(hive.prompt(emp), /you report to lead \(Lead\)/);
  assert.match(hive.prompt(lead), /Your direct reports: emp \(Emp\)/);
  assert.match(hive.prompt(lead), /LEAD for your function/);
  assert.match(hive.prompt(hive.getAgent('orion')), /you report to the human/);
  assert.match(hive.prompt(hive.getAgent('orion')), /Your direct reports: lead/);
  hive.archiveAgent(lead.id);
  assert.equal(hive.getAgent(emp.id).reportsTo, 'orion');
});

test('manager() and reports() follow reportsTo', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const lead = hive.addAgent({ name: 'Lead' });
  const w = hive.addAgent({ name: 'Helper', reportsTo: lead.id });
  assert.equal(hive.manager(w.id).id, lead.id);
  assert.deepEqual(hive.reports(lead.id).map((x) => x.id), [w.id]);
});

test('presets: every crew preset is complete, uses GStack + ECC, and the chain resolves to god', () => {
  const { PRESETS, PRODUCTION_TEAM, WORKFLOW, PLAYBOOK, mergedPresets, planTeam } = require('../src/main/presets');
  for (const [id, p] of Object.entries(PRESETS)) {
    assert.equal(p.id, id);
    for (const k of ['name', 'role', 'instructions']) assert.ok(p[k], `${id}.${k}`);
    if (p.secret) continue; // the secret office is a short, local-model prompt on purpose
    assert.ok(p.lead, `${id} is a lead`);
    assert.match(p.instructions, /GStack/);
    assert.match(p.instructions, /ecc:/);
    let cur = id;
    for (let n = 0; cur !== 'god'; n++) { assert.ok(n < 10 && PRESETS[cur], `${id} chain reaches god`); cur = PRESETS[cur].reportsTo; }
  }
  for (const pid of ['product', 'architect', 'designer', 'frontend', 'backend', 'qa', 'security', 'deploy']) assert.ok(PRODUCTION_TEAM.includes(pid), pid);
  assert.match(PRESETS.security.instructions, /\/cso/);
  assert.match(PRESETS.qa.instructions, /\/qa/);
  assert.match(PRESETS.deploy.instructions, /human's explicit approval/);
  assert.equal(PRESETS.deploy.autonomy, 'ask', 'deployment never defaults to auto-edit');
  assert.ok(PRODUCTION_TEAM.every((pid, i) => { const m = PRESETS[pid].reportsTo; return m === 'god' || PRODUCTION_TEAM.indexOf(m) < i; }), 'managers are hired before their reports');
  // The frontend / designer / backend collaboration is spelled out on both sides.
  assert.match(PRESETS.frontend.instructions, /Designer/);
  assert.match(PRESETS.frontend.instructions, /CONTRACT\.md/);
  assert.match(PRESETS.backend.instructions, /Frontend Lead/);
  assert.match(PRESETS.designer.instructions, /Frontend Lead/);
  assert.ok(WORKFLOW.every((s) => s.who.every((w) => w === 'god' || PRESETS[w])));
  assert.match(PLAYBOOK, /report to the human/);
  // User edits override the template; unknown or non-string values are ignored.
  const m = mergedPresets({ qa: { name: 'Tess', effort: 'max', model: 5 } });
  assert.equal(m.qa.name, 'Tess');
  assert.equal(m.qa.effort, 'max');
  assert.equal(m.qa.model, '');
  assert.ok(m.qa.customized && !m.backend.customized);
  // planTeam: managers first, reuses hired roles, falls back to god.
  const god = { id: 'orion', isGod: true };
  const plan = planTeam([god], mergedPresets({}));
  assert.deepEqual(plan.slice(0, 3).map((h) => [h.presetId, h.reportsTo]), [['product', 'orion'], ['architect', 'orion'], ['designer', 'preset:product']]);
  const again = planTeam([god, { id: 'my-qa', presetId: 'qa' }], mergedPresets({}));
  assert.ok(!again.some((h) => h.presetId === 'qa'));
});

test('every agent prompt (god, worker, preset) carries the Cavemen + Ponytail coding method', () => {
  const { PRESETS } = require('../src/main/presets');
  const hive = freshHive();
  const god = hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const plain = hive.addAgent({ name: 'Plain' });
  const { id: _id, ...tpl } = PRESETS.backend;
  const preset = hive.addAgent({ ...tpl, presetId: 'backend' });
  for (const a of [god, plain, preset]) {
    const p = hive.prompt(a);
    assert.match(p, /CAVEMEN \+ PONYTAIL/, a.name);
    assert.match(p, /TARGET > INSPECT > IMPLEMENT > TEST > VERIFY/, a.name);
    assert.match(p, /YAGNI/, a.name);
    assert.match(p, /standard library first/, a.name);
    assert.match(p, /smallest working diff/, a.name);
  }
});

test('a hired preset keeps its preset id and manager', () => {
  const { PRESETS } = require('../src/main/presets');
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const { id: _id, ...tpl } = PRESETS.architect;
  const arch = hive.addAgent({ ...tpl, presetId: 'architect' });
  const { id: _i2, ...tpl2 } = PRESETS.frontend;
  const fe = hive.addAgent({ ...tpl2, presetId: 'frontend', reportsTo: arch.id });
  assert.equal(fe.presetId, 'frontend');
  assert.equal(hive.manager(fe.id).id, arch.id);
  assert.match(hive.prompt(fe), /STANDING INSTRUCTIONS/);
  assert.match(hive.prompt(fe), /you report to tech-lead \(Tech Lead\)/);
});

test('human as manager: reportsTo "human" is kept, prompts say so, reports move to the human on archive', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const direct = hive.addAgent({ name: 'Direct', reportsTo: 'human' });
  assert.equal(direct.reportsTo, 'human');
  assert.match(hive.prompt(direct), /report DIRECTLY to the human/);
  assert.equal(hive.manager(direct.id), null);
  assert.deepEqual(hive.reports('orion').map((a) => a.id), [], 'the orchestrator does not manage them');
  assert.equal(hive.setManager(direct.id, 'orion'), null);
  assert.equal(hive.setManager(direct.id, 'human'), null);
  const emp = hive.addAgent({ name: 'Emp', reportsTo: direct.id });
  hive.archiveAgent(direct.id);
  assert.equal(hive.getAgent(emp.id).reportsTo, 'human');
});

test('secret office: hidden from the roster, unreachable by agents, every outgoing message is held for the human', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const fe = hive.addAgent({ name: 'Frontend' });
  const sh = hive.addAgent({ id: 'shadow', name: 'Shadow', secret: true, reportsTo: 'human', provider: 'local' });
  assert.equal(sh.secret, true);
  assert.doesNotMatch(hive.prompt(fe), /shadow/i, 'agents never see the secret office');
  assert.match(hive.prompt(sh), /SECRET OFFICE/);
  assert.doesNotMatch(hive.prompt(sh), /CAVEMEN = minimum tokens/, 'the local model gets the one-line method');
  // an agent cannot reach it, and broadcast skips it
  hive.send({ to: 'shadow', subject: 'psst' }, fe.id);
  assert.equal(hive.unread('shadow').length, 0);
  assert.ok(!hive.resolve('broadcast', fe.id).includes('shadow'));
  // the human can
  hive.send({ to: 'shadow', act: 'request', subject: 'research X' }, 'human');
  assert.equal(hive.unread('shadow').length, 1);
  // its message to an implementer lands in the HUMAN inbox, marked secret, not in the implementer's
  hive.send({ to: fe.id, act: 'request', subject: 'Proposal: build it', body: 'do it' }, 'shadow');
  assert.equal(hive.unread(fe.id).length, 0);
  const held = hive.unread('human');
  assert.equal(held.length, 1);
  assert.equal(held[0].secret, true);
  assert.match(held[0].subject, /held for your approval; was to /);
  // via an outbox file too (the real path)
  const godBefore = hive.unread('orion').length; // the bounced "psst" from the agent is already there
  outbox(hive, 'shadow', 'p.json', { to: 'god', act: 'propose', subject: 'Proposal: two' });
  hive.routeOnce();
  assert.equal(hive.unread('orion').length, godBefore, 'nothing from the secret office reached the orchestrator');
  assert.equal(hive.unread('human').length, 2);
  // to the human directly is untouched
  hive.send({ to: 'human', act: 'inform', subject: 'fyi' }, 'shadow');
  assert.equal(hive.unread('human').length, 3);
});

test('kill: removes the agent and its folder, moves reports up, refuses the orchestrator, never leaves hive/agents', () => {
  const hive = freshHive();
  hive.addAgent({ id: 'orion', name: 'Orion', isGod: true });
  const lead = hive.addAgent({ name: 'Lead' });
  const emp = hive.addAgent({ name: 'Emp', reportsTo: lead.id });
  hive.kbWrite(lead.id, 'notes.md', 'hello');
  assert.ok(fs.existsSync(hive.agentDir(lead.id)));
  const keep = path.join(hive.root, 'keep.txt');
  fs.writeFileSync(keep, 'x');
  const r = hive.killAgent(lead.id);
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  assert.ok(!fs.existsSync(hive.agentDir(lead.id)), 'memory, knowledge, inbox and outbox are gone');
  assert.equal(hive.getAgent(lead.id), null, 'gone from the registry, not just archived');
  assert.equal(hive.getAgent(emp.id).reportsTo, 'orion');
  assert.ok(fs.existsSync(hive.agentDir(emp.id)) && fs.existsSync(keep), 'nothing else is touched');
  assert.match(hive.killAgent('orion').error, /cannot be killed/);
  assert.equal(hive.killAgent('nobody').ok, false);
  assert.ok(hive.readLog(20).some((e) => e.type === 'agent-killed' && e.agent === lead.id), 'the audit log keeps a record');
  // a name that tries to escape the agents folder is refused by the guard
  const evil = hive.addAgent({ id: 'x', name: 'X' });
  const reg = hive.registry(); reg.agents.find((a) => a.id === 'x').id = '..'; hive.saveRegistry(reg);
  const sibling = path.join(hive.root, 'tasks.json');
  assert.equal(hive.killAgent('..').removed, false);
  assert.ok(fs.existsSync(sibling) && fs.existsSync(hive.p('agents')), 'path traversal never deletes outside agents/');
  void evil;
});

test('knowledge base: safe file names, size cap, list/read/delete, mentioned in the prompt', () => {
  const hive = freshHive();
  const a = hive.addAgent({ name: 'Kay' });
  assert.ok(hive.kbList(a.id).some((f) => f.name === 'readme.md'), 'seeded with a readme');
  assert.deepEqual(hive.kbWrite(a.id, 'Style Guide.MD', '# tabs'), { ok: true, name: 'style-guide.md' });
  assert.equal(hive.kbRead(a.id, 'style-guide.md'), '# tabs');
  for (const bad of ['../evil.md', '..\\evil.md', 'a.exe', '.md', '', 'x/y.md']) {
    const r = hive.kbWrite(a.id, bad, 'x');
    if (r.ok) assert.ok(!r.name.includes('/') && !r.name.includes('..') && /\.(md|txt)$/.test(r.name), bad); // basename-only normalization
  }
  assert.equal(hive.kbWrite(a.id, 'a.exe', 'x').ok, false);
  assert.equal(hive.kbWrite(a.id, 'big.md', 'x'.repeat(200001)).ok, false);
  assert.ok(!fs.existsSync(path.join(hive.root, 'evil.md')) && !fs.existsSync(path.join(hive.agentDir(a.id), 'evil.md')));
  assert.equal(hive.kbDelete(a.id, 'style-guide.md'), true);
  assert.equal(hive.kbRead(a.id, 'style-guide.md'), null);
  assert.match(hive.prompt(a), /KNOWLEDGE BASE/);
  assert.match(hive.prompt(a), /knowledge/);
});

test('research department and secret office presets: scraping guardrails, local model, human manager', () => {
  const { PRESETS, RESEARCH_TEAM, mergedPresets, planTeam } = require('../src/main/presets');
  assert.deepEqual(RESEARCH_TEAM, ['researchlead', 'scraper', 'analyst']);
  for (const id of RESEARCH_TEAM) {
    const t = PRESETS[id].instructions;
    assert.match(t, /robots\.txt/);
    assert.match(t, /Never bypass CAPTCHAs/);
    assert.match(t, /Cite the source/);
  }
  assert.match(PRESETS.scraper.instructions, /scrapling-official/);
  assert.match(PRESETS.scraper.instructions, /playwright-cli/);
  assert.match(PRESETS.researchlead.instructions, /agent-reach/);
  assert.equal(PRESETS.scraper.reportsTo, 'researchlead');
  assert.equal(PRESETS.secret.provider, 'local');
  assert.equal(PRESETS.secret.secret, true);
  assert.equal(PRESETS.secret.reportsTo, 'human');
  assert.match(PRESETS.secret.instructions, /nothing is dispatched until the human approves/);
  const plan = planTeam([{ id: 'orion', isGod: true }], mergedPresets({}), ['secret', 'researchlead', 'scraper']);
  assert.deepEqual(plan.map((h) => [h.presetId, h.reportsTo]), [['secret', 'human'], ['researchlead', 'orion'], ['scraper', 'preset:researchlead']]);
});

test('local model: claude CLI is pointed at the local server, every model tier maps to it, no effort flag, clear error when not set up', { skip: !resolveCommand('claude') && 'claude not installed' }, () => {
  const { localEnv } = require('../src/main/agents');
  const hive = freshHive();
  const meta = hive.addAgent({ name: 'Loc', provider: 'local', effort: 'high' });
  const none = new AgentManager({ hive, hookUrl: () => 'http://127.0.0.1:1/x', workspace: hive.root });
  assert.throws(() => none.launchSpec(meta, { resume: false }), /local model is not set up/);
  const lm = { baseUrl: 'http://127.0.0.1:11434', model: 'hivedesk-local' };
  const m = new AgentManager({ hive, hookUrl: () => 'http://127.0.0.1:1/x', workspace: hive.root, localModel: () => lm });
  const prev = process.env.ANTHROPIC_BASE_URL; process.env.ANTHROPIC_BASE_URL = 'https://cloud.example'; // must be overridden, not leaked
  try {
    const spec = m.launchSpec(meta, { resume: false });
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(spec.env[k], 'hivedesk-local', k);
    assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
    assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'ollama');
    assert.equal(spec.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(spec.args[spec.args.indexOf('--model') + 1], 'hivedesk-local');
    assert.ok(!spec.args.includes('--effort'), 'a local model has no effort levels');
    assert.ok(spec.args.includes('--append-system-prompt') && spec.hooks, 'same CLI, same hooks');
    assert.equal(localEnv(lm).ANTHROPIC_BASE_URL, lm.baseUrl);
    // a normal Claude agent is unaffected by the local model
    const cloud = hive.addAgent({ name: 'Cloud', provider: 'claude' });
    assert.notEqual(m.launchSpec(cloud, { resume: false }).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434');
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev; }
});

test('claude launch passes --model and --effort', () => {
  const hive = freshHive();
  const meta = hive.addAgent({ name: 'Eve', provider: 'claude', command: process.execPath, model: 'opus', effort: 'xhigh' });
  const m = new AgentManager({ hive, hookUrl: () => 'http://127.0.0.1:1/x', workspace: hive.root });
  const a = m.launchSpec(meta, { resume: false }).args;
  assert.equal(a[a.indexOf('--model') + 1], 'opus');
  assert.equal(a[a.indexOf('--effort') + 1], 'xhigh');
  const none = m.launchSpec({ ...meta, effort: '', model: '' }, { resume: false }).args;
  assert.ok(!none.includes('--effort') && !none.includes('--model'));
});

test('configure: validates, saves, and types /model + /effort only when idle', async () => {
  const hive = freshHive();
  const meta = hive.addAgent({ name: 'Fay', provider: 'claude' });
  const m = new AgentManager({ hive, hookUrl: () => 'http://127.0.0.1:1/x', workspace: hive.root });
  const writes = [];
  m.sessions.set('fay', { proc: { write: (d) => writes.push(d) }, status: 'working', notified: new Set(), buf: '' });
  assert.equal(m.configure('fay', { model: 'bad name; rm -rf' }).ok, false, 'model ids cannot carry spaces or shell text');
  assert.equal(m.configure('fay', { effort: 'ultra' }).ok, false);
  assert.equal(m.configure('nope', { model: 'opus' }).ok, false);
  const busy = m.configure('fay', { model: 'sonnet', effort: 'high' });
  assert.equal(busy.applied, 'when idle');
  assert.deepEqual([hive.getAgent('fay').model, hive.getAgent('fay').effort], ['sonnet', 'high'], 'saved for the next start immediately');
  assert.deepEqual(writes, [], 'nothing typed while the agent is busy');
  m.setStatus('fay', 'idle');
  await new Promise((r) => setTimeout(r, 2400));
  assert.deepEqual(writes, ['/model sonnet', '\r', '/effort high', '\r'], 'slash commands run once it goes idle');
  assert.equal(m.sessions.get('fay').status, 'idle', 'a slash command does not flip the agent to working');
  writes.length = 0;
  assert.equal(m.configure('fay', { effort: 'low' }).applied, 'now');
  assert.equal(m.configure('fay', { model: 'haiku' }).applied, 'now', 'a second change right after the first');
  await new Promise((r) => setTimeout(r, 2600));
  assert.deepEqual(writes, ['/effort low', '\r', '/model haiku', '\r'], 'commands never interleave: each one gets its Enter first');
  m.stopAll();
  assert.equal(m.configure('fay', { model: 'haiku' }).applied, 'next start', 'stopped agents just save it');
});

test('mirror lists and reads Claude Code transcripts (read-only, skips noise and owned sessions)', () => {
  const { Mirror } = require('../src/main/mirror');
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-claude-'));
  const proj = path.join(cfg, 'projects', 'D--Work-demo');
  fs.mkdirSync(proj, { recursive: true });
  const line = (o) => JSON.stringify(o);
  const base = { cwd: path.join(os.tmpdir(), 'demo'), timestamp: '2026-11-23T10:00:00Z' };
  fs.writeFileSync(path.join(proj, 'sess-a.jsonl'), [
    line({ ...base, type: 'custom-title', customTitle: 'Fix login' }),
    line({ ...base, type: 'user', message: { role: 'user', content: 'please fix the login bug' } }),
    line({ ...base, type: 'user', message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } }),
    line({ ...base, type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
    line({ ...base, type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/login.js' } }] } }),
    line({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
    line({ ...base, type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
    'not json at all',
  ].join('\n'));
  fs.writeFileSync(path.join(proj, 'sess-owned.jsonl'), line({ ...base, type: 'user', message: { content: 'mine' } }));
  fs.writeFileSync(path.join(proj, 'sess-old.jsonl'), line({ ...base, type: 'user', message: { content: 'ancient' } }));
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
  fs.utimesSync(path.join(proj, 'sess-old.jsonl'), old, old);

  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const mir = new Mirror();
    const list = mir.list(new Set(['sess-owned']));
    assert.deepEqual(list.map((s) => s.id), ['sess-a'], 'old and hivedesk-owned sessions are not listed');
    assert.deepEqual([list[0].project, list[0].title, list[0].model, list[0].working], ['demo', 'Fix login', 'claude-opus-5-5', true]);
    const r = mir.read('sess-a');
    assert.ok(r.ok);
    assert.deepEqual(r.messages.map((x) => [x.role, x.text]), [['user', 'please fix the login bug'], ['assistant', 'On it.'], ['tool', 'src/login.js']]);
    assert.equal(r.messages[2].name, 'Edit');
    assert.equal(mir.read('../../etc/passwd').ok, false, 'only listed session ids can be read');
    assert.equal(mir.read('sess-old').ok, false);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
