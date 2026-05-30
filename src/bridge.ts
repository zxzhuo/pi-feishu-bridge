/**
 * pi-feishu-bridge — main wiring layer.
 *
 * Features implemented:
 * 1. 真·流式编辑  — capture seedMessageId from first send, then patch
 * 2. Slash 命令自动补全  — /help lists all available commands
 * 3. Session 切换/分叉  — /new /fork /sessions /switch
 * 4. 回复引用上下文  — fetch rootId message and prepend as quote
 * 5. 进程崩溃自愈  — pool.markUnhealthy → recreate on next msg
 * 6. /model /think 透传  — /model [id] /models /think [level]
 * 7. 错误恢复  — extension_error, auto_retry events → user notification
 */

import path from "node:path";
import fs from "node:fs";
import Lark from "@larksuiteoapi/node-sdk";
import { createFeishuService, type FeishuMessageContext } from "feishu-agent-bridge";
import { SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { ChatQueue } from "./chat-queue.js";
import { isAbortTrigger } from "./abort-detect.js";
import { DedupCache } from "./dedup.js";
import { StreamSink } from "./stream-sink.js";
import { SessionPool } from "./session-pool.js";

// ─── Feishu helpers ──────────────────────────────────────────────────────────

/** Send a new text message and return the message_id (or null on failure). */
async function feishuSend(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string
): Promise<string | null> {
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return (res?.data as any)?.message_id ?? null;
  } catch {
    return null;
  }
}

/** Edit an existing text message in place. */
async function feishuPatch(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  text: string
): Promise<void> {
  try {
    await (client.im.message as any).update({
      path: { message_id: messageId },
      data: {
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  } catch {
    // best-effort — if edit fails (rate limit, msg too old, etc.) the next
    // flush retries with newer content.
  }
}

/** Fetch the text content of a message by id (for quote context). */
async function feishuFetchText(
  client: InstanceType<typeof Lark.Client>,
  messageId: string
): Promise<string | null> {
  try {
    const res = await (client.im.message as any).get({ path: { message_id: messageId } });
    const item = res?.data?.items?.[0];
    if (!item) return null;
    const raw = typeof item.body?.content === "string" ? item.body.content : null;
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed.text ?? parsed.content ?? null;
  } catch {
    return null;
  }
}

/** Add an emoji reaction to a message. */
async function feishuReact(
  client: InstanceType<typeof Lark.Client>,
  messageId: string,
  emojiType: string
): Promise<void> {
  try {
    await (client.im as any).v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  } catch (e: any) {
    console.warn(`[bridge] react failed (${emojiType}):`, e?.response?.data?.msg ?? e?.message ?? e);
  }
}

// ─── Command parser ───────────────────────────────────────────────────────────

interface ParsedCommand {
  cmd: string;
  args: string;
}

function parseSlashCommand(text: string): ParsedCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const spaceIdx = t.indexOf(" ");
  if (spaceIdx === -1) return { cmd: t.slice(1).toLowerCase(), args: "" };
  return { cmd: t.slice(1, spaceIdx).toLowerCase(), args: t.slice(spaceIdx + 1).trim() };
}

// ─── Session-level commands ───────────────────────────────────────────────────

async function handleSlashCommand(
  parsed: ParsedCommand,
  runtime: AgentSessionRuntime,
  chatId: string,
  client: InstanceType<typeof Lark.Client>,
  pool: SessionPool,
  cfg: Config
): Promise<boolean> {
  const { cmd, args } = parsed;

  // /help — list available commands
  if (cmd === "help" || cmd === "h") {
    const session = runtime.session;
    const extCmds = (session as any).extensionRunner?.getRegisteredCommands?.() ?? [];
    const templates = (session as any).promptTemplates ?? [];
    const skills = (session as any).resourceLoader?.getSkills?.()?.skills ?? [];

    const lines: string[] = ["**可用命令**\n"];
    lines.push("*系统命令*");
    lines.push("/new — 新建会话");
    lines.push("/sessions — 列出最近会话");
    lines.push("/fork [关键词] — 分叉（从某条历史消息）");
    lines.push("/switch <id> — 切换到指定会话");
    lines.push("/models — 列出可用模型");
    lines.push("/model [id] — 切换模型");
    lines.push("/think [level] — 设置思考级别 off/low/medium/high");
    lines.push("/abort — 中止当前任务");
    lines.push("/status — 显示 session 状态");
    lines.push("/help — 此帮助\n");

    if (extCmds.length > 0) {
      lines.push("*扩展命令*");
      for (const c of extCmds) lines.push(`/${c.invocationName} — ${c.description ?? ""}`);
      lines.push("");
    }
    if (templates.length > 0) {
      lines.push("*提示模板*");
      for (const t of templates) lines.push(`/${t.name} — ${t.description ?? ""}`);
      lines.push("");
    }
    if (skills.length > 0) {
      lines.push("*技能*");
      for (const s of skills) lines.push(`/skill:${s.name} — ${s.description ?? ""}`);
    }

    await feishuSend(client, chatId, lines.join("\n"));
    return true;
  }

  // /abort
  if (cmd === "abort" || cmd === "stop") {
    await runtime.session.abort();
    await feishuSend(client, chatId, "⛔ 已中止");
    return true;
  }

  // /status
  if (cmd === "status") {
    const s = runtime.session;
    const model = (s.state as any)?.model;
    const thinking = (s.state as any)?.thinkingLevel;
    const msgCount = (s.state as any)?.messages?.length ?? 0;
    const sessionFile = s.sessionFile ?? "(in-memory)";
    await feishuSend(
      client,
      chatId,
      `**Session 状态**\n` +
        `模型: ${model?.name ?? "unknown"} (${model?.provider ?? ""})\n` +
        `思考: ${thinking ?? "off"}\n` +
        `消息数: ${msgCount}\n` +
        `文件: ${path.basename(sessionFile)}`
    );
    return true;
  }

  // /new — new session
  if (cmd === "new") {
    await feishuSend(client, chatId, "🆕 正在创建新会话…");
    const result = await runtime.newSession();
    if (result.cancelled) {
      await feishuSend(client, chatId, "❌ 新建会话被取消");
    } else {
      await feishuSend(client, chatId, `✅ 新会话已创建`);
    }
    return true;
  }

  // /sessions — list recent sessions for this chatId
  if (cmd === "sessions") {
    const sessionDir = path.join(
      cfg.sessionBaseDir,
      chatId.replace(/[^a-zA-Z0-9_-]/g, "_")
    );
    const cwd = path.join(cfg.cwdBaseDir, chatId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    try {
      const list = await SessionManager.list(cwd, sessionDir);
      if (list.length === 0) {
        await feishuSend(client, chatId, "（没有历史会话）");
      } else {
        const lines = list.slice(0, 10).map((s, i) => {
          const dt = (s.created instanceof Date ? s.created : new Date(0)).toLocaleString("zh-CN");
          const preview = (s.firstMessage ?? "").slice(0, 40);
          return `${i + 1}. ${s.id.slice(0, 8)}  ${dt}  "${preview}"`;
        });
        await feishuSend(client, chatId, `**最近会话**\n${lines.join("\n")}\n\n用 /switch <序号或id> 切换`);
      }
    } catch {
      await feishuSend(client, chatId, "（读取会话列表失败）");
    }
    return true;
  }

  // /switch <id-or-index>
  if (cmd === "switch") {
    const sessionDir = path.join(cfg.sessionBaseDir, chatId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    const cwd = path.join(cfg.cwdBaseDir, chatId.replace(/[^a-zA-Z0-9_-]/g, "_"));
    try {
      const list = await SessionManager.list(cwd, sessionDir);
      const idx = parseInt(args, 10);
      let target = list.find((s) => s.id.startsWith(args));
      if (!target && !isNaN(idx) && idx >= 1 && idx <= list.length) {
        target = list[idx - 1];
      }
      if (!target) {
        await feishuSend(client, chatId, `❌ 找不到会话 "${args}"`);
      } else {
        const result = await runtime.switchSession(target.path);
        if (result.cancelled) {
          await feishuSend(client, chatId, "❌ 切换被取消");
        } else {
          await feishuSend(client, chatId, `✅ 已切换到会话 ${target.id.slice(0, 8)}`);
        }
      }
    } catch (e) {
      await feishuSend(client, chatId, `❌ 切换失败: ${String(e)}`);
    }
    return true;
  }

  // /fork [keyword] — pick a user message to fork from
  if (cmd === "fork") {
    const forkMessages = (runtime.session as any).getForkMessages?.() ?? [];
    if (forkMessages.length === 0) {
      await feishuSend(client, chatId, "（没有可分叉的历史消息）");
      return true;
    }
    // If arg provided, fuzzy-match; otherwise take last
    let pick = forkMessages[forkMessages.length - 1];
    if (args) {
      const found = forkMessages.find((m: any) => m.text?.includes(args));
      if (found) pick = found;
    }
    const result = await runtime.fork(pick.entryId);
    if (result.cancelled) {
      await feishuSend(client, chatId, "❌ 分叉被取消");
    } else {
      await feishuSend(client, chatId, `✅ 已从「${(result.selectedText ?? "").slice(0, 40)}…」分叉`);
    }
    return true;
  }

  // /models — list available
  if (cmd === "models") {
    const models = runtime.session.modelRegistry.getAvailable();
    if (models.length === 0) {
      await feishuSend(client, chatId, "（没有可用模型）");
    } else {
      const lines = models.map((m) => `• ${m.provider}/${m.id}`);
      await feishuSend(client, chatId, `**可用模型**\n${lines.join("\n")}\n\n用 /model <provider/id> 切换`);
    }
    return true;
  }

  // /model [provider/id] — set or cycle model
  if (cmd === "model") {
    if (!args) {
      const result = await runtime.session.cycleModel();
      const m = result?.model;
      await feishuSend(client, chatId, m ? `✅ 已切换到 ${m.provider}/${m.id}` : "（只有一个模型）");
    } else {
      // args can be "provider/id" or just "id"
      const parts = args.split("/");
      const [provider, modelId] = parts.length >= 2 ? [parts[0], parts.slice(1).join("/")] : [undefined, args];
      const registry = runtime.session.modelRegistry;
      const all = registry.getAvailable();
      const found = provider
        ? registry.find(provider, modelId)
        : all.find((m) => m.id === modelId || m.id.includes(modelId));
      if (!found) {
        await feishuSend(client, chatId, `❌ 找不到模型 "${args}"，用 /models 查看`);
      } else {
        await runtime.session.setModel(found);
        await feishuSend(client, chatId, `✅ 已切换到 ${found.provider}/${found.id}`);
      }
    }
    return true;
  }

  // /think [level]
  if (cmd === "think" || cmd === "thinking") {
    const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
    type Level = (typeof LEVELS)[number];
    if (!args) {
      const level = runtime.session.cycleThinkingLevel();
      await feishuSend(client, chatId, level ? `✅ 思考级别: ${level}` : "（模型不支持思考）");
    } else if (LEVELS.includes(args as Level)) {
      runtime.session.setThinkingLevel(args as Level);
      await feishuSend(client, chatId, `✅ 思考级别: ${args}`);
    } else {
      await feishuSend(client, chatId, `❌ 无效级别。可用: ${LEVELS.join(" / ")}`);
    }
    return true;
  }

  return false; // not handled here — let it pass to pi as a prompt
}

// ─── Main bridge ─────────────────────────────────────────────────────────────

export async function startBridge(cfg: Config): Promise<() => Promise<void>> {
  // ensure dirs
  fs.mkdirSync(cfg.sessionBaseDir, { recursive: true });
  fs.mkdirSync(cfg.cwdBaseDir, { recursive: true });

  const dedup = new DedupCache(5000, cfg.dedupTtlMs);
  const queue = new ChatQueue();
  const pool = new SessionPool({
    sessionBaseDir: cfg.sessionBaseDir,
    cwdBaseDir: cfg.cwdBaseDir,
    agentDir: cfg.agentDir,
    sessionIdleMs: cfg.sessionIdleMs,
    maxSessions: cfg.maxSessions,
    onError: (chatId, err) => {
      console.error(`[pi-feishu] session error (${chatId}): ${err}`);
      pool.markUnhealthy(chatId);
    },
  });

  const service = await createFeishuService({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    transport: cfg.transport,
    onMessage: async (msg: FeishuMessageContext) => {
      console.log(
        `[bridge] onMessage: chat=${msg.chatId.slice(-8)} sender=${msg.senderId.slice(-8)} shouldReply=${msg.shouldReply} ownerOnly=${cfg.ownerOnly} owners=${cfg.allowedOpenIds.length}`
      );
      // 1. dedup
      if (!dedup.check(msg.messageId)) {
        console.log(`[bridge] dropped: dedup`);
        return;
      }

      // 2. owner gate
      if (cfg.ownerOnly && cfg.allowedOpenIds.length > 0 && !cfg.allowedOpenIds.includes(msg.senderId)) {
        console.log(`[bridge] dropped: not owner (${msg.senderId})`);
        return;
      }
      if (!cfg.ownerOnly && cfg.allowedOpenIds.length > 0 && !msg.shouldReply) {
        console.log(`[bridge] dropped: not addressed`);
        return; // group msg not @bot and not in allowlist
      }
      if (!msg.shouldReply) {
        console.log(`[bridge] dropped: shouldReply=false`);
        return;
      }

      const { chatId, content, rootId, messageId } = msg;
      console.log(`[bridge] accepted: "${content.slice(0,80)}"`);
      const client = service.getClient() as unknown as InstanceType<typeof Lark.Client>;

      // ack: react with smiley to acknowledge receipt
      void feishuReact(client, messageId, "SMILE");

      // 3. abort fast path — before queuing
      if (isAbortTrigger(content)) {
        console.log(`[bridge] abort trigger`);
        const runtime = await pool.get(chatId).catch(() => null);
        if (runtime) await runtime.session.abort().catch(() => {});
        return;
      }

      // 4. enqueue
      console.log(`[bridge] enqueue chat=${chatId.slice(-8)}`);
      queue.enqueue(chatId, async () => {
        console.log(`[bridge] queue running chat=${chatId.slice(-8)}`);
        let runtime: AgentSessionRuntime;
        try {
          runtime = await pool.get(chatId);
          console.log(`[bridge] runtime ready chat=${chatId.slice(-8)}`);
        } catch (e) {
          console.error(`[bridge] pool.get failed:`, e);
          await feishuSend(client, chatId, `❌ 会话初始化失败: ${String(e)}`);
          return;
        }

        // 5. slash command?
        const parsed = parseSlashCommand(content);
        if (parsed) {
          const handled = await handleSlashCommand(parsed, runtime, chatId, client, pool, cfg);
          if (handled) return;
          // else fall through to pi (e.g. /skill:xxx or /template)
        }

        // 6. build prompt — prepend quote context if replying to a message
        let promptText = content;
        if (rootId) {
          const quoted = await feishuFetchText(client, rootId).catch(() => null);
          if (quoted) {
            promptText = `【引用】${quoted}\n\n${content}`;
          }
        }

        // 7. streaming reply
        const session = runtime.session;
        let seedMessageId: string | null = null;
        let accumulated = "";
        let sinkClosed = false;
        let lastToolStatus = "";

        const sink = new StreamSink({
          flushMs: cfg.streamFlushMs,
          flushChars: cfg.streamFlushChars,
          onFlush: async (text, isFinal) => {
            if (sinkClosed && !isFinal) return;
            const display = text + (lastToolStatus ? `\n\n${lastToolStatus}` : "");
            if (!seedMessageId) {
              seedMessageId = await feishuSend(client, chatId, display || "…");
            } else {
              await feishuPatch(client, seedMessageId, display || "…");
            }
          },
        });

        // Subscribe to extension errors via the runner (separate channel from
        // AgentSessionEvent stream).
        const runner = (session as any).extensionRunner;
        const unsubExtErr =
          typeof runner?.onError === "function"
            ? runner.onError((err: any) => {
                feishuSend(client, chatId, `⚠️ 扩展错误: ${err?.error ?? String(err)}`).catch(
                  () => {}
                );
              })
            : () => {};

        // Subscribe to session events
        const unsub = session.subscribe((event) => {
          if (event.type === "message_update") {
            const ae = event.assistantMessageEvent;
            if (ae.type === "text_delta") {
              accumulated += ae.delta;
              sink.append(ae.delta);
            }
          } else if (event.type === "agent_end") {
            lastToolStatus = "";
            sink.finish(accumulated).catch(() => {});
          } else if (event.type === "auto_retry_start") {
            feishuSend(
              client,
              chatId,
              `⏳ 请求失败，正在重试 (${event.attempt}/${event.maxAttempts})…`
            ).catch(() => {});
          } else if (event.type === "auto_retry_end" && !event.success) {
            feishuSend(
              client,
              chatId,
              `❌ 重试失败: ${event.finalError ?? "unknown"}`
            ).catch(() => {});
          } else if (event.type === "tool_execution_start") {
            lastToolStatus = `🔧 ${event.toolName}(${JSON.stringify(event.args ?? {}).slice(0, 60)})…`;
            if (seedMessageId) {
              feishuPatch(
                client,
                seedMessageId,
                (accumulated || "…") + `\n\n${lastToolStatus}`
              ).catch(() => {});
            }
          } else if (event.type === "tool_execution_end") {
            lastToolStatus = event.isError
              ? `❌ ${event.toolName} 失败`
              : `✅ ${event.toolName}`;
          }
        });

        try {
          await session.prompt(promptText, {
            streamingBehavior: session.isStreaming ? "followUp" : undefined,
          });
        } catch (e) {
          const errMsg = `❌ 请求失败: ${String(e)}`;
          if (seedMessageId) {
            await feishuPatch(client, seedMessageId, errMsg);
          } else {
            await feishuSend(client, chatId, errMsg);
          }
          // crash self-heal
          pool.markUnhealthy(chatId);
        } finally {
          sinkClosed = true;
          unsub();
          unsubExtErr();
          // ensure final flush
          await sink.finish(accumulated).catch(() => {});
        }
      });
    },
  });

  service.run().catch((e) => console.error("[pi-feishu] service error:", e));

  return async () => {
    await service.shutdown();
    await pool.disposeAll();
  };
}
