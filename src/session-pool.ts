/**
 * Session pool: one AgentSessionRuntime per (chatId, project).
 *
 * Each project = a subdirectory under projectsBaseDir.
 *   cwd = projectsBaseDir/<project>/
 *   sessionDir = projectsBaseDir/<project>/  (same dir)
 *
 * Active project persisted per chatId in projectsBaseDir/.active.json
 */

import path from "node:path";
import fs from "node:fs";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  AgentSessionRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { cleanToolResult, cleanToolResults, collapseToolResults } from "./context-cleaner.js";

export interface PoolEntry {
  runtime: AgentSessionRuntime;
  chatId: string;
  project: string;
  lastUsedAt: number;
  healthy: boolean;
  unsubscribe?: () => void | Promise<void>;
}

export interface SessionPoolOptions {
  /** Base directory where all project directories live. */
  projectsBaseDir: string;
  /** Legacy session dir (kept for compat with old sessions). */
  sessionBaseDir: string;
  /** Legacy cwd dir (kept for compat). */
  cwdBaseDir: string;
  sessionIdleMs: number;
  maxSessions: number;
  agentDir: string;
  onError?: (chatId: string, err: string) => void;
}

function poolKey(chatId: string, project: string): string {
  return `${chatId}::${project}`;
}

// ─── Active project persistence ──────────────────────────────────────────

const ACTIVE_FILE = ".active.json";

function readActiveMap(baseDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, ACTIVE_FILE), "utf8"));
  } catch {
    return {};
  }
}

function writeActiveMap(baseDir: string, map: Record<string, string>): void {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, ACTIVE_FILE), JSON.stringify(map, null, 2));
}

// ─── Project helpers ─────────────────────────────────────────────────────

/** List all project directories under projectsBaseDir (exclude dot-files). */
export function listProjects(projectsBaseDir: string): string[] {
  try {
    return fs.readdirSync(projectsBaseDir).filter((d) => {
      const stat = fs.statSync(path.join(projectsBaseDir, d));
      return stat.isDirectory() && !d.startsWith(".");
    });
  } catch {
    return [];
  }
}

/** Check if a project directory exists. */
export function projectExists(projectsBaseDir: string, name: string): boolean {
  try {
    return fs.statSync(path.join(projectsBaseDir, name)).isDirectory();
  } catch {
    return false;
  }
}

/** Create a new project directory. */
export function createProject(projectsBaseDir: string, name: string): string {
  const dir = path.join(projectsBaseDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── SessionPool ─────────────────────────────────────────────────────────

export class SessionPool {
  private entries = new Map<string, PoolEntry>();
  private gcTimer?: ReturnType<typeof setInterval>;
  private activeProjects = new Map<string, string>();

  constructor(private readonly opts: SessionPoolOptions) {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
  }

  /** Get or create a runtime for (chatId, project). */
  async get(chatId: string, project?: string): Promise<AgentSessionRuntime> {
    const p = project ?? this._getActive(chatId);
    const key = poolKey(chatId, p);
    const existing = this.entries.get(key);
    if (existing && existing.healthy) {
      existing.lastUsedAt = Date.now();
      return existing.runtime;
    }
    if (existing) await this._evictKey(key);
    this.activeProjects.set(chatId, p);
    return this._create(chatId, p);
  }

  /** Switch to a different project. Evicts old runtime. */
  async switchProject(chatId: string, project: string): Promise<string> {
    const dir = this._projectDir(project);
    if (!fs.existsSync(dir)) {
      throw new Error(`项目 "${project}" 不存在`);
    }
    const oldP = this._getActive(chatId);
    const oldKey = poolKey(chatId, oldP);
    if (this.entries.has(oldKey)) await this._evictKey(oldKey);
    this.activeProjects.set(chatId, project);
    this._persistActive(chatId, project);
    return dir;
  }

  /** Mark a session as unhealthy. */
  markUnhealthy(chatId: string): void {
    const p = this._getActive(chatId);
    const e = this.entries.get(poolKey(chatId, p));
    if (e) e.healthy = false;
  }

  /** Evict all runtimes for a chat (all projects). */
  async evict(chatId: string): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(chatId + "::")) {
        await this._evictKey(key);
      }
    }
  }

  async disposeAll(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    await Promise.all([...this.entries.keys()].map((k) => this._evictKey(k)));
  }

  // ── Public helpers ──────────────────────────────────────────────────

  /** Current project for a chat. */
  getActiveProject(chatId: string): string {
    return this._getActive(chatId);
  }

  /** cwd = project dir. */
  getCwd(chatId: string): string {
    return this._projectDir(this._getActive(chatId));
  }

  /** session dir = project dir. */
  getSessionDir(chatId: string): string {
    return this._projectDir(this._getActive(chatId));
  }

  /** Persist active project to disk. */
  persistActiveProject(chatId: string): void {
    this._persistActive(chatId, this._getActive(chatId));
  }

  /** Resolve project dir path. */
  getProjectDir(project: string): string {
    return this._projectDir(project);
  }

  // ── Internal ───────────────────────────────────────────────────────

  private _getActive(chatId: string): string {
    let p = this.activeProjects.get(chatId);
    if (!p) {
      const map = readActiveMap(this.opts.projectsBaseDir);
      p = map[chatId] ?? "default";
      this.activeProjects.set(chatId, p);
    }
    return p;
  }

  private _persistActive(chatId: string, project: string): void {
    const map = readActiveMap(this.opts.projectsBaseDir);
    map[chatId] = project;
    writeActiveMap(this.opts.projectsBaseDir, map);
  }

  private _projectDir(project: string): string {
    return path.join(this.opts.projectsBaseDir, project);
  }

  private async _evictKey(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    await e.unsubscribe?.();
    try { await e.runtime.dispose(); } catch {}
  }

  private async _create(chatId: string, project: string): Promise<AgentSessionRuntime> {
    const projectDir = this._projectDir(project);
    const sessionDir = projectDir; // cwd = session dir
    const cwd = projectDir;
    fs.mkdirSync(sessionDir, { recursive: true });

    const factory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
      const services = await createAgentSessionServices({
        cwd: factoryOpts.cwd,
        agentDir: factoryOpts.agentDir,
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: factoryOpts.sessionManager,
        sessionStartEvent: factoryOpts.sessionStartEvent,
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };

    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: this.opts.agentDir,
      sessionManager: SessionManager.continueRecent(cwd, sessionDir),
    });

    const entry: PoolEntry = { runtime, chatId, project, lastUsedAt: Date.now(), healthy: true };

    let unsubExtErr: (() => void) | undefined;
    const bindRuntimeSession = async (session: AgentSessionRuntime["session"]) => {
      unsubExtErr?.();
      unsubExtErr = undefined;
      await session.bindExtensions({});

      const agent = (session as any).agent;
      if (agent) {
        // transformContext — truncate + collapse before LLM call
        const originalTransform = agent.transformContext;
        agent.transformContext = async (messages: any[], signal?: AbortSignal) => {
          let result = originalTransform ? await originalTransform(messages, signal) : messages;
          result = cleanToolResults(result);
          result = collapseToolResults(result, 40);
          return result;
        };

        // afterToolCall — truncate before writing to state/JSONL
        const originalAfterToolCall = agent.afterToolCall;
        agent.afterToolCall = async (params: any) => {
          const extensionResult = originalAfterToolCall ? await originalAfterToolCall(params) : undefined;
          const finalResult = extensionResult ?? params.result;
          const cleaned = cleanToolResult({
            role: "toolResult",
            toolName: params.toolCall.name,
            content: finalResult.content,
            isError: params.isError,
          });
          if (cleaned.content !== finalResult.content) {
            return { content: cleaned.content, details: finalResult.details };
          }
          return extensionResult;
        };
      }

      // Restore conversation history
      const sm = (session as any).sessionManager;
      if (sm && agent) {
        const sessionContext = sm.buildSessionContext();
        if (sessionContext.messages.length > 0) {
          let msgs = sessionContext.messages;
          msgs = cleanToolResults(msgs);
          msgs = collapseToolResults(msgs, 40);
          agent.state.messages = msgs;
        }
      }

      const runner = (session as any).extensionRunner;
      if (typeof runner?.onError === "function") {
        unsubExtErr = runner.onError((err: any) => {
          this.opts.onError?.(chatId, err?.error ?? String(err));
        });
      }
    };

    runtime.setRebindSession(bindRuntimeSession);
    await bindRuntimeSession(runtime.session);

    entry.unsubscribe = () => {
      runtime.setRebindSession(undefined);
      unsubExtErr?.();
    };

    this.entries.set(poolKey(chatId, project), entry);

    // Evict oldest if over max
    if (this.entries.size > this.opts.maxSessions) {
      let oldest: PoolEntry | undefined;
      for (const e of this.entries.values()) {
        if (!oldest || e.lastUsedAt < oldest.lastUsedAt) oldest = e;
      }
      if (oldest) await this.evict(oldest.chatId);
    }

    return runtime;
  }

  private gc(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.opts.sessionIdleMs) {
        this._evictKey(id).catch(() => {});
      }
    }
  }
}
