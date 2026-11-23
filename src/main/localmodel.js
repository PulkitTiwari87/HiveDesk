'use strict';
// Optional local model: Ollama serving a GGUF, used by "Claude Code (local model)" agents.
// Nothing here runs unless the user turns it on and clicks Set up. Ollama speaks the Anthropic
// Messages API, so the normal `claude` CLI works against it (see localEnv in agents.js).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULTS = {
  enabled: false,
  gguf: 'D:/Local_AI/weights/Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-IQ2_M.gguf',
  name: 'hivedesk-local',
  baseUrl: 'http://127.0.0.1:11434',
  ctx: 32768, // Claude Code's own prompt is ~15k tokens: the Modelfile's 1024 cannot work
};

function findOllama() {
  const cands = [process.env.OLLAMA_BIN, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(d.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    if (d && fs.existsSync(f)) return f;
  }
  return null;
}

const hostOf = (cfg) => { try { return new URL(cfg.baseUrl).host; } catch { return '127.0.0.1:11434'; } };

/** { installed, running, models, hasModel } without side effects. */
async function status(cfg) {
  const out = { installed: !!findOllama(), running: false, models: [], hasModel: false, gguf: fs.existsSync(cfg.gguf) };
  try {
    const r = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    out.models = ((await r.json()).models || []).map((m) => m.name);
    out.running = true;
    out.hasModel = out.models.some((n) => n === cfg.name || n.startsWith(`${cfg.name}:`));
  } catch { /* not running */ }
  return out;
}

/** Start `ollama serve` if nothing answers. Flash attention and a q8 KV cache keep a 27B model's context inside 15 GB RAM + 8 GB VRAM. */
async function ensureServer(cfg) {
  if ((await status(cfg)).running) return { ok: true, started: false };
  const bin = findOllama();
  if (!bin) return { ok: false, error: 'Ollama is not installed. Install it from ollama.com first.' };
  const p = spawn(bin, ['serve'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, OLLAMA_HOST: hostOf(cfg), OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_CONTEXT_LENGTH: String(cfg.ctx) },
  });
  p.on('error', () => {});
  p.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await status(cfg)).running) return { ok: true, started: true };
  }
  return { ok: false, error: 'Ollama did not start within 25 seconds.' };
}

function modelfile(cfg) {
  return [`FROM ${String(cfg.gguf).replace(/\\/g, '/')}`, `PARAMETER num_ctx ${cfg.ctx}`, 'PARAMETER num_batch 32', 'PARAMETER temperature 0.6', 'PARAMETER top_p 0.9', 'PARAMETER top_k 40', ''].join('\n');
}

/** Import the GGUF under cfg.name with a Claude-Code-sized context. Never touches the user's own Modelfile. Copies the GGUF into Ollama's store. */
async function setup(cfg, dataDir, onLog = () => {}) {
  if (!fs.existsSync(cfg.gguf)) return { ok: false, error: `Model file not found: ${cfg.gguf}` };
  const srv = await ensureServer(cfg);
  if (!srv.ok) return srv;
  const file = path.join(dataDir, 'local-model.Modelfile');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, modelfile(cfg), 'utf8');
  const bin = findOllama();
  const code = await new Promise((resolve) => {
    const p = spawn(bin, ['create', cfg.name, '-f', file], { windowsHide: true, env: { ...process.env, OLLAMA_HOST: hostOf(cfg) } });
    const feed = (d) => String(d).split(/[\r\n]+/).filter(Boolean).forEach((l) => onLog(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')));
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', () => resolve(-1));
    p.on('close', resolve);
  });
  if (code !== 0) return { ok: false, error: `ollama create failed (exit ${code}). See the log above.` };
  return { ok: true, ...(await capabilities(cfg)) };
}

/** Does Ollama report tool support for the model? Claude Code is useless without it. */
async function capabilities(cfg) {
  try {
    const r = await fetch(`${cfg.baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model: cfg.name }), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    return { capabilities: j.capabilities || [], tools: (j.capabilities || []).includes('tools') };
  } catch (e) { return { capabilities: [], tools: false, error: String(e.message) }; }
}

/** One real request through the Anthropic endpoint with a tool: proves tool calling works end to end. Loads the model, so it can take minutes. */
async function toolCheck(cfg) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${cfg.baseUrl}/v1/messages`, {
      method: 'POST', signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: { 'content-type': 'application/json', 'x-api-key': 'ollama', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.name, max_tokens: 300,
        messages: [{ role: 'user', content: 'What is the weather in Paris? Call the get_weather tool.' }],
        tools: [{ name: 'get_weather', description: 'Get the weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      }),
    });
    const j = await r.json();
    const blocks = Array.isArray(j.content) ? j.content : [];
    return { ok: r.ok, toolUse: blocks.some((b) => b.type === 'tool_use'), ms: Date.now() - t0, error: r.ok ? '' : JSON.stringify(j).slice(0, 300), text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 200) };
  } catch (e) { return { ok: false, toolUse: false, ms: Date.now() - t0, error: String(e.message) }; }
}

module.exports = { DEFAULTS, findOllama, status, ensureServer, setup, capabilities, toolCheck, modelfile };
