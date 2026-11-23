# Hivedesk — spec (v0.1)

Our own local multi-agent harness, modelled on the open-source (MIT) Munder Difflin
(`HarnessMD/munder-difflin`, v0.5.6). We studied its design (HIVE.md, `src/main/hive.ts`,
`hooks.ts`, `pty.ts`) and rebuilt the core in a much smaller codebase. No code was copied.

## What we kept from the original design (observed in its source)

| Mechanism | Original | Ours |
| --- | --- | --- |
| Agents = real CLI processes in PTYs | node-pty + xterm.js | `@lydell/node-pty` (prebuilt, no compiler) + xterm.js |
| Hive on disk | `hive/` git repo: PROTOCOL.md, registry.json, board.md, tasks.json, log.jsonl, `agents/<id>/{identity.md,memory.md,inbox/,inbox/.done/,outbox/}` | same layout |
| Messaging | FIPA-lite JSON, one file per message, atomic rename, router moves outbox → inbox | same schema (`to/act/subject/body/conversation/in_reply_to`, harness fills `id/from/hops/created_at`) |
| Anti-loop | hop cap, only request/query/propose expect replies, `.done/` idempotency | same; hop cap 8 → bounced to god |
| Orchestrator | "god" agent (Michael in the original, Orion here) delegates via inboxes, sole scribe of board.md | same, auto-spawned on start (toggle) |
| Autonomy loop | Claude Code `Stop` hook returns `{"decision":"block"}` when inbox has unread mail, guarded by `stop_hook_active` | same, hooks forwarded with `curl` to a token-protected loopback HTTP server |
| Waking idle agents | type a nudge into the PTY when an idle agent gets mail | same, once per message id |
| Worker spawning by god | `spawn-requests/<id>.json` polled by harness | same |
| Single committer | only main process runs git | same, debounced commit of the hive (if git exists) |
| Ask-the-human | `humanQA` on task cards + `to:"human"` | `to:"human"` messages land in the UI "Ask me" panel; your reply goes to the sender's inbox |

## Deliberately left out (v0.1)

Pixi office (we draw a small canvas office instead: `src/renderer/office.js`, rectangles only, no sprite assets), voice/dictation, Slack/webhooks, cloud, Pro licensing,
MemPalace vector memory (we do plain-text search over every `memory.md`), Monaco IDE,
telemetry, cost ledger, circuit breaker beyond the hop cap.

## Providers

`claude` (full hive citizen: system-prompt injection, hooks, resumable `--session-id`),
`codex`, `copilot`, `gemini` (prompt injected as the first message, idle detected from PTY
quiet time), `shell` (PowerShell), `custom` (any command line).

## Acceptance

1. `npm start` and the packaged `.exe` open the app; the hive is created under the chosen workspace.
2. Hire an agent → PTY terminal live in the UI, you can type into it.
3. An agent writing a JSON into its `outbox/` is delivered to the recipient's `inbox/`, logged,
   shown on the floor, and an idle recipient is nudged.
4. Claude agents drain their inbox through the Stop hook.
5. God can spawn workers through `spawn-requests/`.
6. Tasks/board/memory/log/ask-me panels reflect the hive files.
7. Unit tests pass (`npm test`).
