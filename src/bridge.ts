/**
 * pi-feishu-bridge — main wiring layer.
 *
 * Features implemented:
 * 1. 卡片流式回复  — CardKit interactive card with typewriter streaming
 * 2. Slash 命令自动补全  — /help lists all available commands
 * 3. Session 切换/分叉  — /new /fork /sessions /switch
 * 4. 回复引用上下文  — fetch rootId message and prepend as quote
 * 5. 进程崩溃自愈  — pool.markUnhealthy → recreate on next msg
 * 6. /model /think 透传  — /model [id] /models /think [level]
 * 7. 错误恢复  — extension_error, auto_retry events → user notification
 * 8. 中间过程展示  — tool execution status in card footer
 * 9. Footer 指标  — elapsed time, token counts, model info
 * 10. Markdown 自动格式化  — content rendered as Feishu card markdown
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
import { SessionPool } from "./session-pool.js";
import { getLogger, initLogger } from "./logger.js";
import { StreamingController } from "./card/streaming-controller.js";
import { formatForCard } from "./card/markdown.js";
import type { CardFooterMetrics } from "./card/types.js";
import { matchSessionCommand } from "./session-matcher.js";
import { listProjects, projectExists, createProject } from "./session-pool.js";

// ─── Feishu helpers ──────────────────────────────────────────────────────────

/** Send a short text message for slash-command replies. */
async function feishuSend(
  client: InstanceType<typeof Lark.Client>,
  chatId: string,
  text: string
): Promise<string | null> {
  getLogger().info(`[bridge] feishuSend to ${chatId.slice(-8)}: "${text.slice(0, 60)}"`);
  try {
    const res = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    const id = (res?.data as any)?.message_id ?? null;
    getLogger().info(`[bridge] feishuSend ok: ${id}`);
    return id;
  } catch (e: any) {
    getLogger().error(`[bridge] feishuSend failed:`, e?.response?.data?.msg ?? e?.message ?? e);
    return null;
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
    getLogger().warn(`[bridge] react failed (${emojiType}):`, e?.response?.data?.msg ?? e?.message ?? e);
  }
}

// ─── Tool args path extraction ───────────────────────────────────────────────

/**
 * Extract a brief path/file summary from tool arguments for display.
 * Truncates to show the last N characters of the path.
 */
function extractToolPathSummary(toolName: string, args: any): string {
  if (!args || typeof args !== "object") return "";

  // Map of tool names to their path-like argument keys
  const pathArgKeys: Record<string, string[]> = {
    read: ["path"],
    write: ["path"],
    edit: ["filePath", "path"],
    bash: ["command"],
    grep: ["path", "pattern"],
    find: ["path", "pattern"],
    ls: ["path"],
    ctx_read: ["path"],
    ctx_ls: ["path"],
    ctx_find: ["pattern"],
    ctx_grep: ["pattern"],
    ctx_shell: ["command"],
    web_search: ["query"],
    fetch_content: ["url"],
    code_search: ["query"],
  };

  const keys = pathArgKeys[toolName] ?? [];
  for (const key of keys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      const trimmed = val.trim();
      // For commands/queries, take first meaningful token
      if (key === "command" || key === "query") {
        const firstLine = trimmed.split(/\n/)[0] ?? "";
        const maxLen = 40;
        const truncated = firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;
        return truncated;
      }
      // For file paths, show last ~40 chars
      const maxLen = 40;
      if (trimmed.length > maxLen) {
        // Try to show the tail with a leading "…/" hint when possible
        const tail = trimmed.slice(-(maxLen - 2));
        const slashIdx = tail.indexOf("/");
        if (slashIdx > 0 && slashIdx < 5) {
          return `…${tail.slice(slashIdx)}`;
        }
        return `…${tail}`;
      }
      return trimmed;
    }
  }
  return "";
}

// ─── Session metrics extraction ──────────────────────────────────────────────

/** Extract footer metrics from the session runtime. */
function extractFooterMetrics(session: any, event?: any): CardFooterMetrics {
  const metrics: CardFooterMetrics = {};

  // Session display name
  const sm = (session as any).sessionManager;
  if (sm?.getSessionName) {
    const name = sm.getSessionName() as string | undefined;
    if (name) metrics.sessionName = name;
  }

  // Model info from session state
  const state = session.state as any;
  const model = state?.model;
  if (model) {
    metrics.model = model.id ?? String(model);
  }

  // Token counts from the last assistant message usage.
  // The agent_end event does NOT carry inputTokens/outputTokens.
  const messages = state?.messages ?? [];
  
  // Debug: check last 3 messages for role/usage
  for (let i = Math.max(0, messages.length - 3); i < messages.length; i++) {
    const m = messages[i];
    getLogger().info(`[footer_debug] msg[${i}]: role=${m?.role}, hasUsage=${!!m?.usage}, usage=${JSON.stringify(m?.usage)}`);
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.usage) {
      metrics.inputTokens = msg.usage.input ?? 0;
      metrics.outputTokens = msg.usage.output ?? 0;
      break;
    }
  }

  // Session elapsed time (from session creation to now)
  const header = sm?.getHeader?.() as { timestamp?: string } | undefined;
  if (header?.timestamp) {
    const created = new Date(header.timestamp).getTime();
    if (!isNaN(created)) {
      metrics.sessionElapsedMs = Date.now() - created;
    }
  }

  // Debug logging for footer metrics
  getLogger().info(
    `[footer] sessionElapsedMs=${metrics.sessionElapsedMs}, sessionName=${metrics.sessionName}, ` +
    `tokens=${metrics.inputTokens}→${metrics.outputTokens}, header=${JSON.stringify(header)}`
  );

  return metrics;
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
    lines.push("/project — 列出项目");
    lines.push("/project <name> — 切换项目");
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

  // /new [name] — new session, optionally with a display name
  if (cmd === "new") {
    const name = args.trim();
    await feishuSend(client, chatId, `🆕 正在创建新会话${name ? `「${name}」` : ""}…`);
    const result = await runtime.newSession({
      setup: name
        ? async (sm) => {
            sm.appendSessionInfo(name);
          }
        : undefined,
    });
    if (result.cancelled) {
      await feishuSend(client, chatId, "❌ 新建会话被取消");
    } else {
      await feishuSend(client, chatId, `✅ 新会话${name ? `「${name}」` : ""}已创建`);
    }
    return true;
  }

  // /project — list / switch / create projects
  if (cmd === "project" || cmd === "projects") {
    if (!args) {
      // List all projects
      const current = pool.getActiveProject(chatId);
      const projects = listProjects(cfg.projectsBaseDir);
      if (projects.length === 0) {
        await feishuSend(client, chatId, "没有项目。用 /project new <名称> 创建");
      } else {
        const lines = projects.map((p) => {
          const marker = p === current ? "▶ " : "  ";
          return `${marker}${p}`;
        });
        await feishuSend(client, chatId, `**项目列表**\n${lines.join("\n")}\n\n用 /project <名称> 切换，/project new <名称> 创建`);
      }
      return true;
    }

    // /project new <name> [cwd-override]
    if (cmd === "project" && args.startsWith("new ")) {
      const name = args.slice(4).trim();
      if (!name) {
        await feishuSend(client, chatId, "❌ 用法: /project new <名称>");
        return true;
      }
      const dir = createProject(cfg.projectsBaseDir, name);
      await pool.switchProject(chatId, name);
      await pool.persistActiveProject(chatId);
      await feishuSend(client, chatId, `✅ 已创建并切换到项目「${name}」\n目录: ${dir}`);
      return true;
    }

    // /project <name> — switch
    if (!projectExists(cfg.projectsBaseDir, args)) {
      await feishuSend(client, chatId, `❌ 项目 "${args}" 不存在。用 /project new ${args} 创建`);
      return true;
    }
    try {
      await pool.switchProject(chatId, args);
      await pool.persistActiveProject(chatId);
      await feishuSend(client, chatId, `✅ 已切换到项目「${args}」`);
    } catch (e: any) {
      await feishuSend(client, chatId, `❌ ${e?.message ?? String(e)}`);
    }
    return true;
  }

  // /sessions — list recent sessions for current project
  if (cmd === "sessions") {
    const sessionDir = pool.getSessionDir(chatId);
    const cwd = pool.getCwd(chatId);
    try {
      const list = await SessionManager.list(cwd, sessionDir);
      if (list.length === 0) {
        await feishuSend(client, chatId, "（没有历史会话）");
      } else {
        const proj = pool.getActiveProject(chatId);
        const lines = list.slice(0, 10).map((s, i) => {
          const dt = (s.created instanceof Date ? s.created : new Date(0)).toLocaleString("zh-CN");
          const name = s.name ? `【${s.name}】` : "";
          const preview = (s.firstMessage ?? "").slice(0, 40);
          return `${i + 1}. ${name}${s.id.slice(0, 8)}  ${dt}  [${proj}] "${preview}"`;
        });
        await feishuSend(client, chatId, `**最近会话**\n${lines.join("\n")}\n\n用 /switch <序号或id> 切换`);
      }
    } catch {
      await feishuSend(client, chatId, "（读取会话列表失败）");
    }
    return true;
  }

  // /switch <id-or-index-or-keyword>
  if (cmd === "switch") {
    const sessionDir = pool.getSessionDir(chatId);
    const cwd = pool.getCwd(chatId);
    try {
      const list = await SessionManager.list(cwd, sessionDir);
      if (!args) {
        // No args: show current session info
        const sm = (runtime.session as any).sessionManager;
        const currentName = sm?.getSessionName?.() as string | undefined;
        const currentId = runtime.session.sessionId?.slice(0, 8) ?? "";
        await feishuSend(
          client,
          chatId,
          `当前会话: ${currentName ? `「${currentName}」` : ""}${currentId}\n用 /switch <关键词> 切换`
        );
        return true;
      }

      const kw = args.toLowerCase();
      const idx = parseInt(args, 10);

      // 1. Try exact ID prefix
      let target = list.find((s) => s.id.startsWith(args));

      // 2. Try numeric index
      if (!target && !isNaN(idx) && idx >= 1 && idx <= list.length) {
        target = list[idx - 1];
      }

      // 3. Try name match (exact → includes)
      if (!target) {
        target = list.find(
          (s) => s.name?.toLowerCase() === kw || s.name?.toLowerCase().includes(kw)
        );
      }

      // 4. Try firstMessage match
      if (!target) {
        target = list.find((s) => s.firstMessage?.toLowerCase().includes(kw));
      }

      // 5. Try full-text search across all messages
      if (!target) {
        // Find all matches sorted by recency, pick the most recent
        const matches = list
          .filter((s) => s.allMessagesText?.toLowerCase().includes(kw))
          .sort((a, b) => b.modified.getTime() - a.modified.getTime());
        if (matches.length > 0) {
          target = matches[0];
          if (matches.length > 1) {
            // Multiple matches: notify user
            await feishuSend(
              client,
              chatId,
              `找到 ${matches.length} 个匹配会话，已切换到最近使用的`
            );
          }
        }
      }

      if (!target) {
        await feishuSend(client, chatId, `❌ 找不到匹配 "${args}" 的会话`);
      } else {
        const result = await runtime.switchSession(target.path);
        if (result.cancelled) {
          await feishuSend(client, chatId, "❌ 切换被取消");
        } else {
          const displayName = target.name ? `「${target.name}」` : target.id.slice(0, 8);
          await feishuSend(
            client,
            chatId,
            `✅ 已切换到会话 ${displayName}（${target.messageCount}条消息）`
          );
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

  // /model [provider/id] — show current model, or switch if argument matches
  if (cmd === "model") {
    const s = runtime.session;
    const currentModel = (s.state as any)?.model;

    if (!args) {
      // No args: just display current model, do NOT switch
      if (currentModel) {
        await feishuSend(client, chatId, `当前模型: ${currentModel.provider}/${currentModel.id}`);
      } else {
        await feishuSend(client, chatId, "当前模型: (未设置)");
      }
      return true;
    }

    // Has args: try to find matching model
    const parts = args.split("/");
    const [provider, modelId] = parts.length >= 2 ? [parts[0], parts.slice(1).join("/")] : [undefined, args];
    const registry = runtime.session.modelRegistry;
    const all = registry.getAvailable();
    const found = provider
      ? registry.find(provider, modelId)
      : all.find((m) => m.id === modelId || m.id.includes(modelId));

    if (!found) {
      await feishuSend(client, chatId, `❌ 找不到模型 "${args}"，用 /models 查看可用模型`);
      return true;
    }

    // Found: switch to it
    await runtime.session.setModel(found);
    await feishuSend(client, chatId, `✅ 已切换到 ${found.provider}/${found.id}`);
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

  return false;
}

// ─── Main bridge ─────────────────────────────────────────────────────────────

export async function startBridge(cfg: Config): Promise<() => Promise<void>> {
  // init logger
  initLogger(cfg.logLevel);
  const log = getLogger();

  // ensure dirs
  fs.mkdirSync(cfg.projectsBaseDir, { recursive: true });
  fs.mkdirSync(cfg.sessionBaseDir, { recursive: true });
  fs.mkdirSync(cfg.cwdBaseDir, { recursive: true });

  const dedup = new DedupCache(5000, cfg.dedupTtlMs);
  const queue = new ChatQueue();
  const pool = new SessionPool({
    projectsBaseDir: cfg.projectsBaseDir,
    sessionBaseDir: cfg.sessionBaseDir,
    cwdBaseDir: cfg.cwdBaseDir,
    agentDir: cfg.agentDir,
    sessionIdleMs: cfg.sessionIdleMs,
    maxSessions: cfg.maxSessions,
    onError: (chatId, err) => {
      log.error(`[pi-feishu] session error (${chatId}): ${err}`);
      pool.markUnhealthy(chatId);
    },
  });

  const service = await createFeishuService({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    transport: cfg.transport,
    onMessage: async (msg: FeishuMessageContext) => {
      log.info(
        `[bridge] onMessage: chat=${msg.chatId.slice(-8)} sender=${msg.senderId.slice(-8)} shouldReply=${msg.shouldReply}`
      );

      // 1. dedup
      if (!dedup.check(msg.messageId)) {
        log.debug(`[bridge] dropped: dedup`);
        return;
      }

      // 2. owner gate
      if (cfg.ownerOnly && cfg.allowedOpenIds.length > 0 && !cfg.allowedOpenIds.includes(msg.senderId)) {
        log.debug(`[bridge] dropped: not owner`);
        return;
      }
      if (!cfg.ownerOnly && cfg.allowedOpenIds.length > 0 && !msg.shouldReply) {
        log.debug(`[bridge] dropped: not addressed`);
        return;
      }
      if (!msg.shouldReply) {
        log.debug(`[bridge] dropped: shouldReply=false`);
        return;
      }

      const { chatId, content, rootId, messageId } = msg;
      log.info(`[bridge] accepted: "${content.slice(0, 80)}"`);
      const client = service.getClient() as unknown as InstanceType<typeof Lark.Client>;

      // ack: react with smiley
      void feishuReact(client, messageId, "SMILE");

      // 3. abort fast path
      if (isAbortTrigger(content)) {
        log.info(`[bridge] abort trigger`);
        const runtime = await pool.get(chatId).catch(() => null);
        if (runtime) await runtime.session.abort().catch(() => {});
        return;
      }

      // 4. enqueue (per-project: different projects in same chat run in parallel)
      const enqKey = `${chatId}::${pool.getActiveProject(chatId)}`;
      log.info(`[bridge] enqueue chat=${chatId.slice(-8)} proj=${pool.getActiveProject(chatId)}`);
      queue.enqueue(enqKey, async () => {
        log.info(`[bridge] queue running chat=${chatId.slice(-8)}`);
        let runtime: AgentSessionRuntime;
        try {
          runtime = await pool.get(chatId);
          log.info(`[bridge] runtime ready chat=${chatId.slice(-8)}`);
        } catch (e) {
          log.error(`[bridge] pool.get failed:`, e);
          await feishuSend(client, chatId, `❌ 会话初始化失败: ${String(e)}`);
          return;
        }

        // 5. slash command?
        const parsed = parseSlashCommand(content);
        if (parsed) {
          try {
            const handled = await handleSlashCommand(parsed, runtime, chatId, client, pool, cfg);
            if (handled) return;
          } catch (cmdErr) {
            log.error(`[bridge] slash command error:`, cmdErr);
            await feishuSend(client, chatId, `❌ 命令执行失败: ${String(cmdErr)}`);
            return;
          }
        }

              // 6. Natural language session matching (no LLM)
        const nlMatch = await matchSessionCommand(
          content,
          pool.getSessionDir(chatId),
          pool.getCwd(chatId),
          pool.getActiveProject(chatId)
        ).catch(() => null);
        if (nlMatch) {
          if (nlMatch.type === "switch" && nlMatch.sessionPath) {
            try {
              const result = await runtime.switchSession(nlMatch.sessionPath);
              if (!result.cancelled) await feishuSend(client, chatId, nlMatch.message);
            } catch (e) {
              await feishuSend(client, chatId, `❌ ${String(e)}`);
            }
          } else if (nlMatch.type === "new") {
            const result = await runtime.newSession();
            if (!result.cancelled) await feishuSend(client, chatId, nlMatch.message);
          } else if (nlMatch.type === "list") {
            // Fall through — send to LLM
          }
          if (nlMatch.type !== "list") return;
        }

        // 7. build prompt with quote context
        let promptText = content;
        if (rootId) {
          const quoted = await feishuFetchText(client, rootId).catch(() => null);
          if (quoted) {
            promptText = `【引用】${quoted}\n\n${content}`;
          }
        }

        // 8. streaming card reply
        const session = runtime.session;
        const ctrl = new StreamingController({ client, chatId });
        let ctrlFinalized = false;
        let lastToolStatus = "";

        const runner = (session as any).extensionRunner;
        const unsubExtErr =
          typeof runner?.onError === "function"
            ? runner.onError((err: any) => {
                feishuSend(client, chatId, `⚠️ 扩展错误: ${err?.error ?? String(err)}`).catch(() => {});
              })
            : () => {};

        const unsub = session.subscribe((event) => {
          if (event.type === "message_update") {
            const ae = event.assistantMessageEvent;
            if (ae.type === "text_delta") {
              // Format markdown content for card rendering
              const formatted = formatForCard(ae.delta);
              ctrl.onDelta(formatted).catch(() => {});
            }
          } else if (event.type === "agent_end") {
            lastToolStatus = "";
            const footerMetrics = extractFooterMetrics(session, event);
            ctrl.finalize({
              elapsedMs: Date.now() - ctrl.startTime,
              footerMetrics,
            }).catch(() => {});
            ctrlFinalized = true;
          } else if (event.type === "auto_retry_start") {
            feishuSend(client, chatId, `⏳ 重试 (${event.attempt}/${event.maxAttempts})…`).catch(() => {});
          } else if (event.type === "auto_retry_end" && !event.success) {
            feishuSend(client, chatId, `❌ 重试失败: ${event.finalError ?? "unknown"}`).catch(() => {});
          } else if (event.type === "tool_execution_start") {
            const pathSummary = extractToolPathSummary(event.toolName, event.args);
            const detail = pathSummary ? ` ${pathSummary}` : "";
            lastToolStatus = `🔧 ${event.toolName}${detail}`;
            ctrl.onToolStatus(`🔧 ${event.toolName}${detail}`).catch(() => {});
          } else if (event.type === "tool_execution_end") {
            const status = event.isError ? `❌ ${event.toolName}` : `✅ ${event.toolName}`;
            lastToolStatus = status;
            ctrl.onToolStatus(status).catch(() => {});
          }
        });

        try {
          const promptPromise = session.prompt(promptText, {
            streamingBehavior: session.isStreaming ? "followUp" : undefined,
          });

          if (cfg.promptTimeoutMs > 0) {
            const timeoutPromise = new Promise<void>((_, reject) => {
              const timer = setTimeout(() => {
                clearTimeout(timer);
                session.abort().catch(() => {});
                reject(new Error(`请求超时 (${(cfg.promptTimeoutMs / 1000).toFixed(0)}s)`));
              }, cfg.promptTimeoutMs);
              promptPromise.finally(() => clearTimeout(timer)).catch(() => {});
            });
            await Promise.race([promptPromise, timeoutPromise]);
          } else {
            await promptPromise;
          }
        } catch (e: any) {
          const errMsg = e?.message ? `❌ ${e.message}` : `❌ 请求失败: ${String(e)}`;
          if (!ctrlFinalized) {
            await ctrl.finalize({ isError: true }).catch(() => {});
            ctrlFinalized = true;
          }
          if (!ctrl.messageId) {
            await feishuSend(client, chatId, errMsg);
          }
          pool.markUnhealthy(chatId);
        } finally {
          if (!ctrlFinalized) {
            await ctrl.finalize().catch(() => {});
          }
          unsub();
          unsubExtErr();
        }
      }).catch((err) => {
        log.error(`[bridge] unhandled queue error (${chatId}):`, err);
      });
    },
  });

  service.run().catch((e) => log.error("[pi-feishu] service error:", e));

  return async () => {
    await service.shutdown();
    await pool.disposeAll();
  };
}
