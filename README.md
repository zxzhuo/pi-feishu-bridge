# pi-feishu-bridge

Connect Feishu (Lark) chats to a [pi](https://github.com/earendil-works/pi-coding-agent)
agent. One pi session per Feishu chat — group, DM, anything — with full
slash command support, fork/switch, model swap, real streaming edits, and
crash self-healing.

## Architecture at a glance

```
Feishu WS  ──▶  feishu-agent-bridge  ──▶  pi-feishu-bridge ──▶  pi AgentSession
                  (transport only)         (this package)        (per chatId)
```

* **Per-chat queue** — one chat's messages run sequentially.
* **Per-chat AgentSession** — `~/.pi-feishu/sessions/<chat>/`, persistent across bridge restarts.
* **Per-chat cwd** — `~/.pi-feishu/workspaces/<chat>/`, isolated working dir.
* **Idle GC** — sessions disposed after 30 min of silence (configurable).

## Features

| Feature | How it works |
|---|---|
| **Streaming edits** | First reply captures `message_id`; subsequent deltas call `im.message.update` to edit the same message in place. |
| **Slash command list** | `/help` lists system commands plus any extension, prompt-template, and skill commands registered in pi. |
| **Session switch / fork** | `/sessions`, `/switch <id-or-index>`, `/fork [keyword]`, `/new` — backed by `AgentSessionRuntime`. |
| **Reply-quote context** | When a user quotes a previous message (`rootId` present), the original text is fetched and prepended to the prompt. |
| **Crash self-healing** | Extension errors and thrown `prompt()` calls mark the session unhealthy; the next message silently creates a fresh one. |
| **Model and thinking controls** | `/models` lists options; `/model <provider/id>` switches; `/think <level>` sets reasoning depth. |
| **Error recovery** | `auto_retry_*` events surface as brief status messages; unrecoverable failures are reported inline. |
| **Fast abort** | Plain "stop" / "abort" / "wait" (and equivalents) abort the current run before queuing a new one. |
| **Dedup** | Bounded LRU keyed by `messageId`, 10 min TTL, handles Feishu event retries transparently. |
| **Owner gate** | `allowedOpenIds` + `ownerOnly: true` restricts which Feishu users the bot responds to. |
| **Reaction acknowledgement** | Bot adds a 😊 reaction to each incoming message immediately on receipt. |

## Install

```bash
cd pi-feishu-bridge
npm install
npm run build
```

## Configure

`~/.config/pi-feishu/config.json`:

```json
{
  "appId": "cli_xxxxxxxxxxxx",
  "appSecret": "${FEISHU_APP_SECRET}",
  "transport": "ws",
  "allowedOpenIds": ["ou_xxx"],
  "ownerOnly": false,
  "sessionIdleMs": 1800000,
  "streamFlushMs": 350,
  "streamFlushChars": 80,
  "logLevel": "info"
}
```

`${VAR}` placeholders are expanded from environment variables. Or set everything via env:

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=...
```

The pi side picks up models, skills, and extensions exactly as a normal
`pi` invocation would in `cwd = ~/.pi-feishu/workspaces/<chat>/`.

## Run

### Recommended: `pi-feishu-ctl`

```bash
# First-time install (symlink to ~/.local/bin)
./scripts/pi-feishu-ctl install

# Daily use
pi-feishu-ctl start          # start in background (auto-builds if needed)
pi-feishu-ctl status         # running state + last 12 log lines
pi-feishu-ctl logs           # last 100 lines
pi-feishu-ctl logs -f        # follow live
pi-feishu-ctl restart        # stop + start
pi-feishu-ctl stop           # graceful stop
pi-feishu-ctl run            # foreground run (Ctrl-C to quit)
pi-feishu-ctl build          # rebuild TypeScript only
pi-feishu-ctl config         # print config (appSecret redacted)
pi-feishu-ctl autostart on   # register macOS LaunchAgent (start on login, auto-restart on crash)
pi-feishu-ctl autostart off  # unregister LaunchAgent
```

Output goes to `logs/run.log`; PID is tracked in `logs/pid`; previous log is kept as `run.log.prev` on restart.

### Manual

```bash
npm start            # or: node bin/pi-feishu.js
```

## Slash commands

| Command | Action |
|---|---|
| `/help` | List all available commands (system + extensions + skills) |
| `/status` | Show current model, thinking level, message count, session file |
| `/new` | Start a fresh session in this chat |
| `/sessions` | List up to 10 recent sessions (newest first) |
| `/switch <id-or-index>` | Switch to a previous session |
| `/fork [keyword]` | Fork from a previous user message (most recent if no keyword given) |
| `/abort` | Stop the current agent run |
| `/models` | List configured models |
| `/model <provider/id>` | Switch model (omit arg to cycle) |
| `/think [level]` | Set thinking level: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| Any other `/cmd` | Falls through to pi as a prompt — extension commands, skills, and templates all work |

## Design notes

* The SDK is used directly (`createAgentSessionRuntime`) rather than spawning
  `pi --mode rpc` to avoid JSONL-framing edge cases and keep latency low.
* `AgentSessionRuntime` is required (not `AgentSession`) because fork, clone,
  and switchSession all live on the runtime, not the session.
* Streaming is throttled to one Feishu API call per `streamFlushMs` ms
  **and** per `streamFlushChars` chars added, whichever fires first.
* `extension_error` is delivered via `runner.onError(listener)` — separate
  from the `AgentSessionEvent` stream — so both channels are wired.
* Reaction emoji uses `im.v1.messageReaction.create` (not the nested
  `im.message.messageReaction` path in the type definitions).
* Text message edits use `im.message.update` (requires `msg_type` +
  `content`); `im.message.patch` is for interactive cards only.

## What's not done yet

* Image / file uploads in incoming messages → `prompt({ images: [...] })`
* Interactive cards for `extension_ui_request` (confirm / select / input / editor)
* OAuth device flow (single-tenant only right now)
* Bitable / Calendar / Doc / Wiki tool plugins (better as a separate pi MCP server)
* Multi-account support

## Files

```
src/
├── abort-detect.ts   keyword-based fast abort
├── bridge.ts         main wiring (slash commands, streaming, queue, errors)
├── chat-queue.ts     per-chat serial queue
├── config.ts         config loader (file + env)
├── dedup.ts          LRU dedup of incoming message ids
├── index.ts          public exports
├── session-pool.ts   per-chat AgentSessionRuntime pool with idle GC + self-heal
└── stream-sink.ts    interval+chars throttled flush helper
bin/
└── pi-feishu.js      CLI entry
```

## License

MIT.
