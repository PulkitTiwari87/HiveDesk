'use strict';
// AgentManager: runs every agent as a real CLI process in a pseudo-terminal,
// tracks its status, and wakes idle agents that have unread mail.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

let pty = null;
function loadPty() { if (!pty) pty = require('@lydell/node-pty'); return pty; }

const IS_WIN = process.platform === 'win32';
const REPLAY_LIMIT = 256 * 1024; // bytes of scrollback kept per agent for the UI
const QUIET_MS = 4000; // no output for this long => idle (providers without hooks)
const HOOK_GRACE_MS = 20000; // how long a hook-driven agent may stay "starting" before we fall back
// Interactive startup menus (folder trust, update offers, confirmations) belong
// to the human: while one is on screen the harness never types into the terminal.
const TRUST_PROMPT = /trust\s*this\s*folder|trust\s*the\s*files|Do\s*you\s*trust|Press\s*enter\s*to\s*continue|Enter\s*to\s*confirm|Update\s*now/i;
const CLAUDE_ENV_KEEP = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_GIT_BASH_PATH']);
const ANSI =/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[\w.\-:\/\[\]]{1,80}$/; // alias or full model id; no spaces or control characters (it may be typed into a TUI)

const PROVIDERS = {
  claude: { label: 'Claude Code', bin: 'claude', hooks: true },
  codex: { label: 'OpenAI Codex', bin: 'codex' },
  gemini: { label: 'Gemini CLI', bin: 'gemini' },
  copilot: { label: 'GitHub Copilot CLI', bin: 'copilot' },
  shell: { label: 'Shell (PowerShell)', bin: IS_WIN ? 'powershell.exe' : 'bash', plain: true },
  custom: { label: 'Custom command', bin: '' },
};

/** Find an executable on PATH. On Windows unwraps npm .cmd shims into the real
 *  .exe / node script so arguments are passed verbatim (cmd.exe would mangle
 *  the multi-line system prompt). */
function resolveCommand(bin, pathEnv = process.env.PATH || process.env.Path || '') {
  if (!bin) return null;
  if (path.isAbsolute(bin) && fs.existsSync(bin)) return unwrap(bin);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ''), bin + ext);
      try { if (fs.statSync(full).isFile()) return unwrap(full); } catch {}
    }
  }
  return null;
}

function unwrap(full) {
  if (!IS_WIN || !/\.(cmd|bat)$/i.test(full)) return { file: full, pre: [] };
  let text = '';
  try { text = fs.readFileSync(full, 'utf8'); } catch {}
  const dp0 = path.dirname(full);
  const m = text.match(/"%dp0%\\([^"]+?\.(exe|js|cjs|mjs))"/i);
  if (m) {
    const target = path.join(dp0, m[1]);
    if (fs.existsSync(target)) {
      if (/\.exe$/i.test(target)) return { file: target, pre: [] };
      const node = fs.existsSync(path.join(dp0, 'node.exe')) ? path.join(dp0, 'node.exe') : (resolveCommand('node') || {}).file;
      if (node) return { file: node, pre: [target] };
    }
  }
  return { file: process.env.ComSpec || 'cmd.exe', pre: ['/d', '/s', '/c', full] };
}

function oneLine(s) { return String(s).replace(/\s*\n\s*/g, ' ').trim(); }

class AgentManager extends EventEmitter {
  constructor({ hive, hookUrl, workspace }) {
    super();
    this.hive = hive;
    this.hookUrl = hookUrl; // (agentId) => URL
    this.workspace = workspace;
    this.sessions = new Map(); // id -> { proc, buf, status, lastTool, quietTimer, notified:Set, ... }
  }

  info(id) {
    const s = this.sessions.get(id);
    return s ? { status: s.status, lastTool: s.lastTool, ask: s.ask || '', pid: s.proc ? s.proc.pid : null, error: s.error || null } : { status: 'stopped', lastTool: '', ask: '', pid: null, error: null };
  }

  /** `ask` is the permission text from a Claude Notification hook; it only lives while status is "waiting". */
  setStatus(id, status, extra = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    const ask = status === 'waiting' ? (extra.ask !== undefined ? extra.ask : s.ask || '') : '';
    const changed = s.status !== status || ask !== (s.ask || '') || (extra.lastTool !== undefined && extra.lastTool !== s.lastTool);
    s.ask = ask;
    s.status = status;
    if (extra.lastTool !== undefined) s.lastTool = extra.lastTool;
    if (changed) this.emit('status', id, this.info(id));
    if (status === 'idle' && s.pending) this.applyPending(id);
  }

  /** Change model / effort. Always saved for the next start; a running Claude agent also gets
   *  /model and /effort typed into its terminal, immediately if idle, otherwise when it next goes idle. */
  configure(id, { model, effort } = {}) {
    const patch = {};
    if (model !== undefined) {
      const m = String(model).trim();
      if (m && !MODEL_RE.test(m)) return { ok: false, error: 'That is not a valid model name.' };
      patch.model = m;
    }
    if (effort !== undefined) {
      if (effort && !EFFORTS.includes(effort)) return { ok: false, error: `Effort must be one of: ${EFFORTS.join(', ')}.` };
      patch.effort = effort || '';
    }
    const meta = this.hive.updateAgent(id, patch);
    if (!meta) return { ok: false, error: 'unknown agent' };
    const s = this.sessions.get(id);
    if (!s || !s.proc || meta.provider !== 'claude') return { ok: true, applied: 'next start' };
    // Clearing back to "default" has no slash command: that part waits for the next start.
    const live = { ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) };
    if (!Object.keys(live).length) return { ok: true, applied: 'next start' };
    s.pending = { ...s.pending, ...live };
    if (s.status === 'idle') { this.applyPending(id); return { ok: true, applied: 'now' }; }
    return { ok: true, applied: 'when idle' };
  }

  applyPending(id) {
    const s = this.sessions.get(id);
    if (!s || !s.pending || !s.proc) return;
    const { model, effort } = s.pending;
    s.pending = null;
    const cmds = [model && `/model ${model}`, effort && `/effort ${effort}`].filter(Boolean);
    // One slash command at a time per agent: a second change must not be typed before the first one's Enter.
    let at = Math.max(0, (s.slashUntil || 0) - Date.now());
    for (const c of cmds) {
      setTimeout(() => {
        // Written straight to the terminal: a slash command is not a turn, so it must not flip the status to working.
        if (!s.proc) return;
        s.proc.write(c);
        setTimeout(() => { if (s.proc) s.proc.write('\r'); }, 400);
      }, at);
      at += 1500;
    }
    s.slashUntil = Date.now() + at;
    this.hive.log({ type: 'agent-configured', agent: id, model: model || '', effort: effort || '' });
  }

  /** Build {file, args, env, typedPrompt} for an agent. */
  launchSpec(meta, { resume }) {
    const prov = PROVIDERS[meta.provider] || PROVIDERS.custom;
    const dir = this.hive.agentDir(meta.id);
    const env = {
      ...process.env,
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: this.hive.root,
      AGENT_DIR: dir,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    // Do not leak a parent Claude session's markers into agents: they break
    // login and --resume ("inherited CLAUDE_CODE_CHILD_SESSION marker").
    const insideClaude = 'CLAUDECODE' in env || 'CLAUDE_CODE_CHILD_SESSION' in env;
    for (const k of Object.keys(env)) {
      if (/^CLAUDE(CODE|_)/.test(k) && !CLAUDE_ENV_KEEP.has(k)) delete env[k];
    }
    if (insideClaude) delete env.ANTHROPIC_BASE_URL;
    Object.assign(env, { AGENT_ID: meta.id, AGENT_NAME: meta.name, HIVE_ROOT: this.hive.root, AGENT_DIR: dir });
    const resuming = !!(resume && meta.started);
    const args = [];
    let typedPrompt = null;
    let resolved;
    let rawArgs = null;

    if (meta.provider === 'custom') {
      const cmdline = meta.command || (IS_WIN ? 'powershell.exe' : 'bash');
      // On Windows hand cmd the line verbatim: node-pty would turn every " into \" which cmd does not understand.
      if (IS_WIN) rawArgs = `/d /s /c "${cmdline}"`;
      resolved = IS_WIN
        ? { file: process.env.ComSpec || 'cmd.exe', pre: [] }
        : { file: '/bin/sh', pre: ['-c', cmdline] };
      if (!resuming) typedPrompt = oneLine(this.hive.prompt(meta));
    } else {
      resolved = resolveCommand(meta.command || prov.bin, env.PATH || env.Path);
      if (!resolved) throw new Error(`"${meta.command || prov.bin}" was not found on PATH. Install ${prov.label} first or pick another engine.`);
    }

    if (meta.provider === 'claude') {
      args.push('--append-system-prompt', this.hive.prompt(meta));
      args.push('--add-dir', this.hive.root);
      args.push('--settings', this.writeClaudeSettings(meta));
      if (resuming) args.push('--resume', meta.sessionId);
      else args.push('--session-id', meta.sessionId);
      if (meta.model) args.push('--model', meta.model);
      if (EFFORTS.includes(meta.effort)) args.push('--effort', meta.effort);
      if (meta.autonomy === 'edits') args.push('--permission-mode', 'acceptEdits');
      if (meta.autonomy === 'full') args.push('--dangerously-skip-permissions');
    } else if (meta.provider === 'codex') {
      if (meta.model) args.push('--model', meta.model);
      if (meta.autonomy === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
      else {
        args.push('--sandbox', 'workspace-write', '--ask-for-approval', meta.autonomy === 'edits' ? 'on-request' : 'untrusted');
        args.push('--add-dir', this.hive.root);
      }
      if (!resuming) args.push(oneLine(this.hive.prompt(meta)));
    } else if (meta.provider === 'gemini') {
      if (meta.model) args.push('--model', meta.model);
      if (meta.autonomy !== 'ask') args.push('--yolo');
      if (!resuming) args.push('--prompt-interactive', oneLine(this.hive.prompt(meta)));
    } else if (meta.provider === 'copilot') {
      if (meta.model) args.push('--model', meta.model);
      if (meta.autonomy === 'full') args.push('--allow-all-tools');
      if (!resuming) typedPrompt = oneLine(this.hive.prompt(meta));
    }

    return { file: resolved.file, args: rawArgs !== null ? rawArgs : [...resolved.pre, ...args], env, typedPrompt, hooks: !!prov.hooks, plain: !!prov.plain };
  }

  writeClaudeSettings(meta) {
    const url = this.hookUrl(meta.id);
    const command = `curl -s -m 25 -X POST -H "Content-Type: application/json" --data-binary @- "${url}"`;
    const h = (matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 30 }] }];
    const settings = {
      hooks: {
        SessionStart: h(),
        UserPromptSubmit: h(),
        PreToolUse: h('*'),
        PostToolUse: h('*'),
        Notification: h(),
        Stop: h(),
      },
    };
    const file = path.join(this.hive.agentDir(meta.id), 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
    return file;
  }

  failed(id, error) {
    const prev = this.sessions.get(id);
    this.sessions.set(id, { proc: null, buf: prev ? prev.buf : '', status: 'error', lastTool: '', notified: prev ? prev.notified : new Set(), error });
    this.emit('status', id, this.info(id));
    return { ok: false, error };
  }

  start(meta, { resume = false, cols = 120, rows = 32 } = {}) {
    if (this.sessions.get(meta.id)?.proc) return { ok: true };
    let spec;
    try {
      this.hive.ensureAgentFiles(meta); // the folder may have been deleted by hand
      spec = this.launchSpec(meta, { resume });
    } catch (e) { return this.failed(meta.id, e.message); }
    let cwd = meta.cwd || this.workspace;
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { cwd = this.workspace; }
    let proc;
    try {
      proc = loadPty().spawn(spec.file, spec.args, { name: 'xterm-256color', cols, rows, cwd, env: spec.env, useConpty: true });
    } catch (e) { return this.failed(meta.id, e.message); }
    const prev = this.sessions.get(meta.id);
    const s = {
      proc, buf: prev ? prev.buf : '', status: 'starting', lastTool: '', notified: prev ? prev.notified : new Set(),
      hooks: spec.hooks, plain: spec.plain, typedPrompt: spec.typedPrompt, quietTimer: null, lastWake: 0, error: null,
      startedAt: Date.now(), hookSeen: false, sinceInput: '',
    };
    this.sessions.set(meta.id, s);
    const wasStarted = meta.started;
    if (!meta.started) this.hive.updateAgent(meta.id, { started: true });
    this.hive.log({ type: 'agent-started', agent: meta.id, resume: !!(resume && wasStarted) });

    proc.onData((d) => {
      s.buf += d;
      s.sinceInput = (s.sinceInput + d).slice(-4000);
      if (s.buf.length > REPLAY_LIMIT) s.buf = s.buf.slice(-REPLAY_LIMIT);
      this.emit('data', meta.id, d);
      this.onActivity(meta.id, s);
    });
    proc.onExit(({ exitCode }) => {
      clearTimeout(s.quietTimer);
      if (this.sessions.get(meta.id) === s && s.proc) {
        s.proc = null;
        this.setStatus(meta.id, 'exited');
        this.hive.log({ type: 'agent-exited', agent: meta.id, code: exitCode });
        this.emit('exit', meta.id, exitCode);
      }
    });
    this.emit('status', meta.id, this.info(meta.id));
    return { ok: true };
  }

  /** Output-driven status for providers without hooks, plus the first typed prompt. */
  onActivity(id, s) {
    if (!s.hooks && !s.plain && s.status === 'idle') this.setStatus(id, 'working');
    // A CLI asking whether to trust the folder needs the human: never type into it.
    if (!s.hookSeen && TRUST_PROMPT.test(s.sinceInput.replace(ANSI, ''))) {
      clearTimeout(s.quietTimer);
      if (s.status !== 'waiting') this.setStatus(id, 'waiting');
      return;
    }
    this.armQuiet(id, s, s.status === 'starting' ? 2500 : QUIET_MS);
  }

  armQuiet(id, s, delay) {
    clearTimeout(s.quietTimer);
    s.quietTimer = setTimeout(() => {
      if (!s.proc) return;
      // Hook-driven agents become idle on their SessionStart hook; the quiet
      // timer only takes over when hooks never arrive (e.g. curl missing).
      if (s.hooks && !s.hookSeen) {
        const left = HOOK_GRACE_MS - (Date.now() - s.startedAt);
        if (left > 0) { this.armQuiet(id, s, left); return; }
      }
      if (s.typedPrompt) {
        const text = s.typedPrompt; s.typedPrompt = null;
        this.type(id, text);
        return;
      }
      if (s.status === 'starting' || (!s.hooks && s.status === 'working')) this.setStatus(id, 'idle');
    }, delay);
  }

  /** Type text into the agent's terminal and press Enter. */
  type(id, text) {
    const s = this.sessions.get(id);
    if (!s || !s.proc) return false;
    s.sinceInput = '';
    s.proc.write(text);
    setTimeout(() => { if (s.proc) s.proc.write('\r'); }, 400);
    if (!s.plain) this.setStatus(id, 'working');
    return true;
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || !s.proc) return;
    s.sinceInput = '';
    if (s.status === 'waiting' && !s.hooks) this.setStatus(id, 'working');
    s.proc.write(data);
  }
  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.proc && cols > 1 && rows > 1) { try { s.proc.resize(cols, rows); } catch {} }
  }
  replay(id) { return this.sessions.get(id)?.buf || ''; }

  stop(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.quietTimer);
    const proc = s.proc;
    s.proc = null;
    if (proc) { try { proc.kill(); } catch {} }
    this.setStatus(id, 'stopped');
  }
  stopAll() { for (const id of this.sessions.keys()) this.stop(id); }
  forget(id) { this.stop(id); this.sessions.delete(id); }

  // ---------- hive integration ----------

  /** Unread messages this agent has not been told about yet. */
  fresh(id) {
    const s = this.sessions.get(id);
    if (!s) return [];
    return this.hive.unread(id).filter((m) => !s.notified.has(m.id));
  }

  inboxNudge(id, msgs) {
    const list = msgs.slice(0, 8).map((m) => `[${m.act}] from ${m.from}: "${m.subject}"`).join('; ');
    const more = msgs.length > 8 ? ` (+${msgs.length - 8} more)` : '';
    return `[hive] You have ${msgs.length} new message(s) in ${this.hive.inboxDir(id)}: ${list}${more}. Read each file, act on it, reply via your outbox if it expects a reply, then move it to inbox/.done/.`;
  }

  /** Wake an idle agent that has mail it has not been told about. */
  maybeWake(id) {
    const s = this.sessions.get(id);
    if (!s || !s.proc || s.plain || s.status !== 'idle' || s.typedPrompt) return false;
    if (Date.now() - s.lastWake < 5000) return false;
    const msgs = this.fresh(id);
    if (!msgs.length) return false;
    msgs.forEach((m) => s.notified.add(m.id));
    s.lastWake = Date.now();
    this.hive.log({ type: 'agent-woken', agent: id, messages: msgs.length });
    return this.type(id, this.inboxNudge(id, msgs));
  }

  /** Claude Code hook payload -> status update and optional decision. */
  onHook(id, p) {
    const s = this.sessions.get(id);
    if (!s) return {};
    s.hookSeen = true;
    const ev = p.hook_event_name;
    if (ev === 'SessionStart') { this.setStatus(id, 'idle'); return {}; }
    if (ev === 'UserPromptSubmit') { this.setStatus(id, 'working'); return {}; }
    if (ev === 'PreToolUse') {
      this.setStatus(id, 'working', { lastTool: p.tool_name || '' });
      this.emit('tool', id, p.tool_name || '');
      return {};
    }
    if (ev === 'PostToolUse') { this.setStatus(id, 'working'); return {}; }
    if (ev === 'Notification') {
      const msg = String(p.message || '');
      if (/permission|approve|allow/i.test(msg)) this.setStatus(id, 'waiting', { ask: msg });
      else this.setStatus(id, 'idle');
      return {};
    }
    if (ev === 'Stop') {
      // Autonomy loop: keep the agent working while it has new mail.
      // stop_hook_active means we already blocked once this turn: let it stop.
      const msgs = this.fresh(id);
      if (msgs.length && !p.stop_hook_active) {
        msgs.forEach((m) => s.notified.add(m.id));
        this.hive.log({ type: 'stop-blocked', agent: id, messages: msgs.length });
        return { decision: 'block', reason: this.inboxNudge(id, msgs) };
      }
      this.setStatus(id, 'idle');
      return {};
    }
    return {};
  }
}

module.exports = { AgentManager, PROVIDERS, EFFORTS, resolveCommand };
