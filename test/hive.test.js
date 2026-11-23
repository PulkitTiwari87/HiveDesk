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
