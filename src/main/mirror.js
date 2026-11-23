'use strict';
// Read-only mirror of Claude Code chats. Claude Code (CLI, desktop app, IDE) writes every session to
// <config>/projects/<project>/<session>.jsonl; we only read those files, so nothing in the user's
// Claude settings is changed and it works for sessions started anywhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RECENT_MS = 3 * 24 * 3600 * 1000; // only sessions touched in the last 3 days
const WORKING_MS = 8000; // transcript written this recently => the agent is mid-turn
const MAX_SESSIONS = 40;
const HEAD_BYTES = 96 * 1024;
const TAIL_BYTES = 768 * 1024;

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
}

const jsonLines = (text) => text.split('\n').map((l) => { try { return l ? JSON.parse(l) : null; } catch { return null; } }).filter(Boolean);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return clip(String(v).replace(/\s+/g, ' ').trim(), 140);
}

/** One transcript entry -> zero or more display messages: {t, role: user|assistant|tool, text|name+text}. */
function toMessages(o) {
  if (!o || o.isSidechain || o.isMeta) return [];
  const m = o.message;
  if (!m) return [];
  const out = [];
  if (o.type === 'user') {
    const parts = typeof m.content === 'string' ? [m.content] : (Array.isArray(m.content) ? m.content.filter((c) => c.type === 'text').map((c) => c.text) : []);
    for (const raw of parts) {
      let text = String(raw).trim();
      const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
      if (cmd) { const args = text.match(/<command-args>([^<]*)<\/command-args>/); text = (cmd[1] + ' ' + (args ? args[1] : '')).trim(); }
      else if (text.startsWith('<')) continue; // system reminders, command output, caveats
      if (text) out.push({ t: o.timestamp, role: 'user', text: clip(text, 4000) });
    }
  } else if (o.type === 'assistant' && Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'text' && c.text && c.text.trim()) out.push({ t: o.timestamp, role: 'assistant', text: clip(c.text.trim(), 6000), model: m.model });
      else if (c.type === 'tool_use') out.push({ t: o.timestamp, role: 'tool', name: c.name, text: summarize(c.input) });
    }
  }
  return out;
}

class Mirror {
  constructor() { this.cache = new Map(); } // session id -> { file, mtime, summary }

  /** Recent sessions, newest first. `skip` = session ids that Hivedesk agents own (they have their own terminal). */
  /** Delete one Claude Code transcript (and its same-named folder) by exact session id. Only ever touches `<id>.jsonl` / `<id>/` under projects/. */
  deleteSession(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) return false;
    const root = path.join(configDir(), 'projects');
    let removed = false;
    this.cache.delete(id);
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return false; }
    for (const d of dirs) {
      const file = path.join(root, d, `${id}.jsonl`), folder = path.join(root, d, id);
      try { if (fs.statSync(file).isFile()) { fs.unlinkSync(file); removed = true; } } catch { /* not in this project */ }
      try { if (fs.statSync(folder).isDirectory()) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* none */ }
    }
    return removed;
  }

  list(skip = new Set()) {
    const root = path.join(configDir(), 'projects');
    const found = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return []; }
    const now = Date.now();
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -6);
        if (skip.has(id)) continue;
        const file = path.join(root, d, f);
        let st; try { st = fs.statSync(file); } catch { continue; }
        if (now - st.mtimeMs > RECENT_MS) continue;
        found.push({ id, file, mtime: st.mtimeMs, size: st.size, dir: d });
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, MAX_SESSIONS).map((s) => {
      let c = this.cache.get(s.id);
      if (!c || c.mtime !== s.mtime) {
        c = { file: s.file, mtime: s.mtime, summary: this.summary(s) };
        this.cache.set(s.id, c);
      }
      return { id: s.id, ...c.summary, mtime: s.mtime, working: now - s.mtime < WORKING_MS };
    });
  }

  summary({ file, size, dir }) {
    let cwd = '', title = '', first = '', model = '';
    try {
      for (const o of jsonLines(readRange(file, 0, Math.min(size, HEAD_BYTES)))) {
        if (o.cwd && !cwd) cwd = o.cwd;
        if (o.type === 'custom-title' && o.customTitle) title = o.customTitle;
        if (!first && o.type === 'user') { const u = toMessages(o).find((m) => m.role === 'user'); if (u) first = u.text; }
      }
      const tailStart = Math.max(0, size - 128 * 1024);
      for (const o of jsonLines(readRange(file, tailStart, size - tailStart)).reverse()) {
        if (o.type === 'assistant' && o.message && o.message.model) { model = o.message.model; break; }
      }
    } catch {}
    const project = cwd ? path.basename(cwd) : dir;
    return { project, cwd, title: clip((title || first || '(no prompt yet)').replace(/\s+/g, ' '), 100), model };
  }

  /** Last `limit` display messages of a listed session. Only ids returned by list() are readable. */
  read(id, limit = 200) {
    const c = this.cache.get(id);
    if (!c) return { ok: false, error: 'unknown session' };
    let st; try { st = fs.statSync(c.file); } catch { return { ok: false, error: 'transcript is gone' }; }
    const start = Math.max(0, st.size - TAIL_BYTES);
    let text = readRange(c.file, start, st.size - start);
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const messages = jsonLines(text).flatMap(toMessages).slice(-limit);
    return { ok: true, messages, mtime: st.mtimeMs, working: Date.now() - st.mtimeMs < WORKING_MS, truncated: start > 0 };
  }
}

module.exports = { Mirror, toMessages };
