# pi-feishu-bridge

Connect Feishu (Lark) chats to a [pi](https://github.com/earendil-works/pi-coding-agent)
agent. One pi session per Feishu chat — group, DM, anything — with full
slash command support, fork/switch, model swap, real streaming card edits,
and crash self-healing.

## Architecture at a glance

```
Feishu WS  ──▶  feishu-agent-bridge  ──▶  pi-feishu-bridge ──▶  pi AgentSession
                  (transport only)         (this package)        (per chatId)
```

* **Per-chat queue** — one chat's messages run sequentially.
* **Per-chat AgentSession** — `~/.pi-feishu/sessions/<chat>/`, persistent across
  bridge restarts.
* **Per-chat cwd** — `~/.pi-feishu/workspaces/<chat>/`, isolated working dir.
* **Idle GC** — sessions disposed after 30 min of silence (configurable).

## Features

| Feature | How it works |
|---|---|
| **真·流式编辑** | First send captures `message_id`, subsequent deltas use `im.message.patch` to edit in place. |
| **Slash 命令补全** | `/help` lists system + extension + prompt + skill commands. |
| **Session 切换/分叉** | `/sessions`, `/switch <id-or-index>`, `/fork [keyword]`, `/new`. Backed by `AgentSessionRuntime`. |
| **回复引用上下文** | When the user quotes a previous message (`rootId` is set), we fetch its content via Lark API and prepend `【引用】…` before the prompt. |
| **进程崩溃自愈** | `extension_error` / `prompt()` throws → mark session unhealthy → next message creates a fresh one. |
| **`/model` `/think` 透传** | `/models` lists, `/model <provider/id>` switches, `/think <level>` sets reasoning level. |
| **错误恢复** | `auto_retry_*` events → user-visible "正在重试" / "重试失败" messages. |
| **Fast abort** | "stop" / "abort" / "等等" / "/abort" → immediate `session.abort()`, before queuing. |
| **Dedup** | Bounded LRU keyed by `messageId`, 10 min TTL by default. |
| **Owner gate** | `allowedOpenIds` + `ownerOnly: true` → only listed open IDs handled. |

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

`${VAR}` placeholders are expanded from environment variables. Or set
everything via env:

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=...
```

The pi side picks up models, skills, extensions exactly like a normal
`pi` invocation in `cwd = ~/.pi-feishu/workspaces/<chat>/`.

## Run

### 推荐：用控制脚本 `pi-feishu-ctl`

```bash
# 首次安装（软连到 ~/.local/bin，以后任意目录都能调）
./scripts/pi-feishu-ctl install

# 日常使用
pi-feishu-ctl start          # 后台启动（需要时自动 build）
pi-feishu-ctl status         # 运行状态 + 最后 12 行日志
pi-feishu-ctl logs           # 最后 100 行
pi-feishu-ctl logs -f        # 跟随输出
pi-feishu-ctl restart        # 重启
pi-feishu-ctl stop           # 停止
pi-feishu-ctl run            # 前台运行（调试用，Ctrl-C 退出）
pi-feishu-ctl build          # 只重新编译
pi-feishu-ctl config         # 查看当前配置（appSecret 已脱敏）
pi-feishu-ctl autostart on   # 注册 macOS LaunchAgent，开机/登录自动启动 + 挂了重拉
pi-feishu-ctl autostart off  # 取消自动启动
```

脚本会在 `logs/run.log` 记录输出，`logs/pid` 记录 PID，重启时会把上一份日志转为 `run.log.prev`。

### 手动起动

```bash
npm start            # 或：node bin/pi-feishu.js
```

## Slash commands

| Command | Action |
|---|---|
| `/help` | List all available commands (system + extensions + skills) |
| `/status` | Show current model, thinking level, message count, session file |
| `/new` | Start a fresh session in this chat |
| `/sessions` | List up to 10 recent sessions (latest first) |
| `/switch <id-or-index>` | Switch to a previous session |
| `/fork [keyword]` | Fork from a previous user message (last one if no keyword) |
| `/abort` | Stop the current agent run |
| `/models` | List configured models |
| `/model <provider/id>` | Switch model (or omit args to cycle) |
| `/think [level]` | Set thinking level: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| Any other `/cmd` | Falls through to pi as a prompt — extension commands, skills, templates all work |

## Design notes

* We use the SDK directly (`createAgentSessionRuntime`) instead of spawning
  `pi --mode rpc` to avoid the JSONL framing edge cases (U+2028/U+2029 in
  JSON strings) and to keep latency low.
* `AgentSessionRuntime` is required (not `AgentSession`) because fork /
  clone / switchSession all live there.
* Streaming is throttled to one Feishu API call every `streamFlushMs` ms
  *and* every `streamFlushChars` chars added, whichever comes first. Tool
  execution status is appended after the response text.
* `extension_error` is delivered via `runner.onError(listener)`, not the
  AgentSessionEvent stream. We wire both.

## What's not done yet

These are tracked in `memory/lark_bridge_rpc_capability_gap.md`. Roughly:

* Image/file uploads in incoming messages → `prompt({ images: [...] })`
* Interactive cards for `extension_ui_request` (confirm/select/input/editor)
* OAuth device flow (single-tenant only right now)
* Bitable / Calendar / Doc / Wiki tool plugins (better as separate pi MCP server)
* Reactions, comment targets, VC events
* Multi-account

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
