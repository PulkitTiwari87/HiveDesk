'use strict';
// The hive: file-based coordination layer shared by every agent.
// Layout (under <workspace>/hive):
//   PROTOCOL.md  registry.json  board.md  tasks.json  log.jsonl
//   spawn-requests/{.done,.failed}/   human/inbox/{.done}/
//   agents/<id>/{identity.md, memory.md, inbox/, inbox/.done/, outbox/}
// Rules: every agent writes only inside its own folder; only the harness moves
// messages (outbox -> inbox) and only the harness runs git.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HOP_CAP = 8;
const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];
const REPLY_ACTS = ['request', 'query', 'propose'];

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function rand() { return crypto.randomBytes(3).toString('hex'); }
function slug(s) { return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${rand()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function writeJson(file, data) { atomicWrite(file, JSON.stringify(data, null, 2) + '\n'); }
function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch { return []; }
}

const PROTOCOL_MD = `# Hive protocol

You are one of several AI agents sharing this hive. Coordination is entirely
file-based. The harness is the only thing that moves messages and runs git.

## Your workspace: agents/<your-id>/
- identity.md   who you are (read-only, the harness writes it)
- memory.md     your long-term memory. Read it at the start of a task, append as you learn.
- inbox/        messages addressed to you. Read them at the start of a task.
- inbox/.done/  move a message here once you have handled it.
- outbox/       drop messages here to send them. The harness delivers them.

Never write into another agent's folder. Write to your own outbox/.

## Sending a message
Write ONE JSON file into your outbox/ (any name ending in .json):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast | human",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details (markdown ok)",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<id of the message you are answering> (optional)"
}
\`\`\`

The harness fills in id, from, hops and created_at.

## Rules
- Only request, query and propose expect a reply. inform and done are terminal: do not reply to them.
- Each reply increments hops. Past ${HOP_CAP} hops a thread is escalated to the human.
- For anything ambiguous, cross-cutting or needing sign-off, message "god" (the orchestrator).
- Use "to": "human" only for decisions only the human can make. Keep it short, start with one bold sentence.
- board.md is the shared plan. Only god edits it; others propose changes to god.
- tasks.json is the task ledger: [{ "id", "title", "status": "todo|doing|blocked|done", "assignee", "notes" }].
  Keep the status of the task you work on accurate.
- Re-reading a message already in .done/ is a no-op. Do not reprocess.

## Spawning a worker (god only)
Write ONE JSON file into spawn-requests/<anything>.json in the hive root:
\`\`\`json
{ "name": "Dwight", "role": "what this worker is for", "objective": "the task", "cwd": "C:/abs/path (optional)", "provider": "claude | codex | gemini | copilot (optional)" }
\`\`\`
The harness spawns it, delivers the objective to its inbox and moves the request to .done/ (or .failed/ with a reason).
`;

class Hive {
  constructor(root) {
    this.root = root;
    this.hops = new Map(); // message id -> hops, used to count reply depth
    this.onLog = null;
  }

  p(...parts) { return path.join(this.root, ...parts); }
  agentDir(id) { return this.p('agents', id); }

  init() {
    for (const d of ['agents', 'spawn-requests/.done', 'spawn-requests/.failed', 'human/inbox/.done']) {
      fs.mkdirSync(this.p(d), { recursive: true });
    }
    fs.writeFileSync(this.p('PROTOCOL.md'), PROTOCOL_MD, 'utf8');
    if (!fs.existsSync(this.p('registry.json'))) writeJson(this.p('registry.json'), { agents: [] });
    if (!fs.existsSync(this.p('tasks.json'))) writeJson(this.p('tasks.json'), []);
    if (!fs.existsSync(this.p('board.md'))) fs.writeFileSync(this.p('board.md'), '# Board\n\n_The shared plan. God is the only scribe._\n', 'utf8');
    if (!fs.existsSync(this.p('log.jsonl'))) fs.writeFileSync(this.p('log.jsonl'), '', 'utf8');
    if (!fs.existsSync(this.p('.gitignore'))) fs.writeFileSync(this.p('.gitignore'), '*.tmp\nagents/*/settings.json\n', 'utf8');
    // Rebuild the hop index from history so reply depth survives restarts.
    for (const ev of this.readLog(2000)) if (ev.type === 'message' && ev.id) this.hops.set(ev.id, ev.hops || 0);
  }

  // ---------- registry ----------
  registry() { return readJson(this.p('registry.json'), { agents: [] }); }
  saveRegistry(reg) { writeJson(this.p('registry.json'), reg); }
  agents({ includeArchived = false } = {}) {
    return this.registry().agents.filter((a) => includeArchived || !a.archived);
  }
  getAgent(id) { return this.registry().agents.find((a) => a.id === id) || null; }
  god() { return this.agents().find((a) => a.isGod) || null; }

  uniqueId(name) {
    const taken = new Set(this.registry().agents.map((a) => a.id).concat(['god', 'human', 'broadcast']));
    const base = slug(name);
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  addAgent(input) {
    const reg = this.registry();
    const meta = {
      id: input.id || this.uniqueId(input.name),
      name: input.name || 'Agent',
      role: input.role || 'General purpose engineer',
      provider: input.provider || 'claude',
      command: input.command || '',
      model: input.model || '',
      autonomy: input.autonomy || 'edits',
      cwd: input.cwd || '',
      isGod: !!input.isGod,
      sessionId: input.sessionId || crypto.randomUUID(),
      started: false,
      createdAt: new Date().toISOString(),
      archived: false,
    };
    reg.agents = reg.agents.filter((a) => a.id !== meta.id);
    reg.agents.push(meta);
    this.saveRegistry(reg);
    this.ensureAgentFiles(meta);
    this.log({ type: 'agent-hired', agent: meta.id, name: meta.name, provider: meta.provider });
    return meta;
  }

  updateAgent(id, patch) {
    const reg = this.registry();
    const a = reg.agents.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    this.saveRegistry(reg);
    if (!a.archived) this.ensureAgentFiles(a);
    return a;
  }

  archiveAgent(id) {
    const a = this.updateAgent(id, { archived: true });
    if (a) this.log({ type: 'agent-archived', agent: id });
    return a;
  }

  ensureAgentFiles(meta) {
    const dir = this.agentDir(meta.id);
    for (const d of ['inbox/.done', 'outbox']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.md'),
      `# ${meta.name} (${meta.id})\n\n- Role: ${meta.role}\n- Engine: ${meta.provider}\n- Orchestrator: ${meta.isGod ? 'yes (god)' : 'no'}\n`, 'utf8');
    const mem = path.join(dir, 'memory.md');
    if (!fs.existsSync(mem)) fs.writeFileSync(mem, `# Memory: ${meta.name}\n\n_Append durable facts, decisions and context below._\n`, 'utf8');
  }

  // ---------- prompt injected into every agent ----------
  prompt(meta) {
    const dir = this.agentDir(meta.id);
    const roster = this.agents().map((a) => `${a.id} (${a.name}: ${a.role}${a.isGod ? ', orchestrator' : ''})`).join('; ');
    const lines = [
      `You are "${meta.name}" (agent id: ${meta.id}), an autonomous agent in a collaborating hive of AI agents. Your role: ${meta.role}.`,
      `Your private hive folder is ${dir}. The shared hive is ${this.root}. Full protocol: ${this.p('PROTOCOL.md')}.`,
      'HIVE PROTOCOL, follow it on every task:',
      `1. At the START of a task read ${path.join(dir, 'memory.md')} and EVERY file in ${path.join(dir, 'inbox')}. After handling a message move its file into ${path.join(dir, 'inbox', '.done')}.`,
      `2. To ask another agent for something or report back, write ONE message JSON into ${path.join(dir, 'outbox')} (schema in PROTOCOL.md). NEVER write into another agent's folder.`,
      '3. When you finish work that someone requested, send them an "act":"done" message with the result.',
      '4. Append durable facts and what you learned to memory.md.',
      `Current roster: ${roster || 'just you'}. The live roster is always in ${this.p('registry.json')}.`,
    ];
    if (meta.isGod) {
      lines.push(
        'You are the GOD / ORCHESTRATOR of this hive. Your job is to ORCHESTRATE, not to implement.',
        '(1) AWARENESS: know every agent (registry.json), every task (tasks.json) and all in-flight work; drain your inbox continually and answer other agents so the team runs autonomously.',
        '(2) DELEGATE: break the human\'s requests into tasks and dispatch them to agents via messages. Prefer an existing agent whose role fits; spawn a worker (spawn-requests/, see PROTOCOL.md) only when none fits.',
        'Write each dispatch as a contract: OBJECTIVE, OUTPUT, TOOLS/REFERENCES, BOUNDARIES + definition of done. Pass file paths, not pasted content.',
        `(3) You are the sole scribe of ${this.p('board.md')} and keep ${this.p('tasks.json')} accurate (set "assignee" when you dispatch).`,
        'Escalate to the human (a message "to":"human") only for destructive actions, spending money, scope changes or unresolvable conflicts.'
      );
    } else {
      lines.push('For anything ambiguous, cross-cutting or needing sign-off, message "god".');
    }
    lines.push('Env vars available: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.');
    return lines.join('\n');
  }

  // ---------- messaging ----------
  normalize(partial, from) {
    const act = ACTS.includes(partial.act) ? partial.act : 'inform';
    let hops = 0;
    if (partial.in_reply_to && this.hops.has(partial.in_reply_to)) hops = this.hops.get(partial.in_reply_to) + 1;
    return {
      id: `${stamp()}-${rand()}`,
      conversation: partial.conversation || `conv-${rand()}`,
      in_reply_to: partial.in_reply_to || null,
      from,
      to: String(partial.to || 'god'),
      act,
      subject: String(partial.subject || '').slice(0, 300),
      body: typeof partial.body === 'string' ? partial.body : JSON.stringify(partial.body ?? ''),
      hops,
      requires_reply: REPLY_ACTS.includes(act),
      needs_human: !!partial.needs_human,
      created_at: new Date().toISOString(),
    };
  }

  /** Resolve a "to" field into concrete recipient ids ('human' allowed). */
  resolve(to, from) {
    const key = String(to).trim().toLowerCase();
    const live = this.agents();
    if (key === 'human' || key === 'user') return ['human'];
    if (key === 'broadcast' || key === 'all') return live.filter((a) => a.id !== from).map((a) => a.id);
    if (key === 'god' || key === 'orchestrator') {
      const g = live.find((a) => a.isGod);
      return g ? [g.id] : ['human'];
    }
    const hit = live.find((a) => a.id === key) || live.find((a) => a.name.toLowerCase() === key);
    return hit ? [hit.id] : [];
  }

  inboxDir(id) { return id === 'human' ? this.p('human', 'inbox') : path.join(this.agentDir(id), 'inbox'); }

  deliverTo(msg, id) {
    const dir = this.inboxDir(id);
    if (!fs.existsSync(dir)) return false;
    writeJson(path.join(dir, `${msg.id}.json`), msg);
    return true;
  }

  /** Normalize + route one message. Returns [{msg, to}] deliveries. */
  send(partial, from) {
    const msg = this.normalize(partial, from);
    let targets = this.resolve(msg.to, from);
    let escalated = false;
    if (msg.hops > HOP_CAP) { targets = ['human']; escalated = true; msg.needs_human = true; }
    if (!targets.length) {
      // Unknown recipient: bounce to god (or to the human when god sent it / no god).
      const g = this.god();
      msg.subject = `[undeliverable to "${msg.to}"] ${msg.subject}`;
      targets = [g && g.id !== from ? g.id : 'human'];
    }
    const out = [];
    this.hops.set(msg.id, msg.hops);
    for (const t of targets) if (this.deliverTo(msg, t)) out.push({ msg, to: t });
    this.log({ type: 'message', id: msg.id, from, to: targets, act: msg.act, subject: msg.subject, hops: msg.hops, escalated });
    return out;
  }

  /** Drain every outbox once. Returns all deliveries made. */
  routeOnce() {
    const deliveries = [];
    for (const a of this.agents()) {
      const outbox = path.join(this.agentDir(a.id), 'outbox');
      for (const f of listJson(outbox)) {
        const file = path.join(outbox, f);
        let partial;
        try {
          partial = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        } catch (e) {
          // Possibly mid-write by the agent: retry next tick unless it is stale.
          let age = 0;
          try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
          if (age > 10000) {
            fs.mkdirSync(path.join(outbox, '.bad'), { recursive: true });
            try { fs.renameSync(file, path.join(outbox, '.bad', f)); } catch {}
            this.log({ type: 'bad-message', agent: a.id, file: f, error: String(e.message) });
          }
          continue;
        }
        const list = Array.isArray(partial) ? partial : [partial];
        for (const m of list) if (m && typeof m === 'object') deliveries.push(...this.send(m, a.id));
        try { fs.unlinkSync(file); } catch {}
      }
    }
    return deliveries;
  }

  unread(id) {
    const dir = this.inboxDir(id);
    return listJson(dir).map((f) => {
      const m = readJson(path.join(dir, f), null);
      return m ? { ...m, _file: f } : null;
    }).filter(Boolean);
  }

  markDone(id, file) {
    const dir = this.inboxDir(id);
    const base = path.basename(file);
    try { fs.renameSync(path.join(dir, base), path.join(dir, '.done', base)); return true; } catch { return false; }
  }

  // ---------- spawn requests (god -> harness) ----------
  takeSpawnRequests() {
    const dir = this.p('spawn-requests');
    const out = [];
    for (const f of listJson(dir)) {
      const file = path.join(dir, f);
      const req = readJson(file, null);
      if (!req) {
        let age = 0;
        try { age = Date.now() - fs.statSync(file).mtimeMs; } catch {}
        if (age > 10000) this.finishSpawnRequest(f, false, 'invalid JSON');
        continue;
      }
      out.push({ file: f, req });
    }
    return out;
  }

  finishSpawnRequest(f, ok, reason) {
    const dir = this.p('spawn-requests');
    const dest = path.join(dir, ok ? '.done' : '.failed', f);
    try { fs.renameSync(path.join(dir, f), dest); } catch {}
    if (!ok && reason) { try { fs.writeFileSync(dest + '.reason.txt', reason, 'utf8'); } catch {} }
    this.log({ type: ok ? 'spawn-request-done' : 'spawn-request-failed', file: f, reason: reason || '' });
  }

  // ---------- shared surfaces ----------
  log(ev) {
    const entry = { ts: new Date().toISOString(), ...ev };
    fs.appendFileSync(this.p('log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    if (this.onLog) this.onLog(entry);
  }
  readLog(n = 200) {
    let text = '';
    try { text = fs.readFileSync(this.p('log.jsonl'), 'utf8'); } catch { return []; }
    const lines = text.trim() ? text.trim().split('\n') : [];
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  tasks() { const t = readJson(this.p('tasks.json'), []); return Array.isArray(t) ? t : (t.tasks || []); }
  saveTasks(tasks) { writeJson(this.p('tasks.json'), tasks); }
  board() { try { return fs.readFileSync(this.p('board.md'), 'utf8'); } catch { return ''; } }
  saveBoard(text) { atomicWrite(this.p('board.md'), text); }
  memory(id) { try { return fs.readFileSync(path.join(this.agentDir(id), 'memory.md'), 'utf8'); } catch { return ''; } }

  searchMemory(q) {
    const needle = String(q || '').toLowerCase().trim();
    if (!needle) return [];
    const hits = [];
    for (const a of this.agents({ includeArchived: true })) {
      this.memory(a.id).split('\n').forEach((text, i) => {
        if (text.toLowerCase().includes(needle)) hits.push({ agent: a.id, name: a.name, line: i + 1, text });
      });
    }
    return hits.slice(0, 300);
  }
}

module.exports = { Hive, HOP_CAP, slug, readJson, writeJson, atomicWrite };
