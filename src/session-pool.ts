/**
 * Session pool: one AgentSessionRuntime per chatId.
 *
 * Features:
 * - cwd isolation per chat
 * - idle GC
 * - crash self-healing (marks unhealthy → recreates on next access)
 * - exposes runtime for fork/clone/switchSession
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

export interface PoolEntry {
  runtime: AgentSessionRuntime;
  chatId: string;
  lastUsedAt: number;
  healthy: boolean;
  unsubscribe?: () => void | Promise<void>;
}

export interface SessionPoolOptions {
  sessionBaseDir: string;
  cwdBaseDir: string;
  sessionIdleMs: number;
  maxSessions: number;
  /** pi agent config directory containing settings.json/models.json/auth.json */
  agentDir: string;
  /** Called when a session emits an error / becomes unhealthy */
  onError?: (chatId: string, err: string) => void;
}

export class SessionPool {
  private entries = new Map<string, PoolEntry>();
  private gcTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: SessionPoolOptions) {
    this.gcTimer = setInterval(() => this.gc(), 60_000);
  }

  /** Get or create a session runtime for chatId. Recreates if unhealthy. */
  async get(chatId: string): Promise<AgentSessionRuntime> {
    const existing = this.entries.get(chatId);
    if (existing && existing.healthy) {
      existing.lastUsedAt = Date.now();
      return existing.runtime;
    }
    if (existing) {
      // unhealthy — tear down first
      await this.evict(chatId);
    }
    return this.create(chatId);
  }

  /** Mark a session as unhealthy so it will be recreated next time. */
  markUnhealthy(chatId: string): void {
    const e = this.entries.get(chatId);
    if (e) e.healthy = false;
  }

  async evict(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (!e) return;
    this.entries.delete(chatId);
    await e.unsubscribe?.();
    try {
      await e.runtime.dispose();
    } catch {
      // best-effort
    }
  }

  async disposeAll(): Promise<void> {
    if (this.gcTimer) clearInterval(this.gcTimer);
    await Promise.all([...this.entries.keys()].map((k) => this.evict(k)));
  }

  private sessionDirFor(chatId: string): string {
    // sanitize chatId for use as directory name
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.opts.sessionBaseDir, safe);
  }

  private cwdFor(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.opts.cwdBaseDir, safe);
  }

  private async create(chatId: string): Promise<AgentSessionRuntime> {
    const sessionDir = this.sessionDirFor(chatId);
    const cwd = this.cwdFor(chatId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // The runtime reuses this factory for /new, /switch and /fork.
    // Keep it aligned with the SDK runtime example so every replacement gets
    // fresh cwd-bound services and the correct session_start metadata.
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

    const entry: PoolEntry = {
      runtime,
      chatId,
      lastUsedAt: Date.now(),
      healthy: true,
    };

    // Extension bindings and extension-runner subscriptions are session-local.
    // AgentSessionRuntime replaces `runtime.session` on /new, /switch and /fork,
    // so rebind these hooks every time a replacement happens.
    let unsubExtErr: (() => void) | undefined;
    const bindRuntimeSession = async (session: AgentSessionRuntime["session"]) => {
      unsubExtErr?.();
      unsubExtErr = undefined;

      await session.bindExtensions({});

      // Subscribe to extension errors via the runner — separate from the
      // AgentSessionEvent stream.
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
      unsubExtErr = undefined;
    };

    this.entries.set(chatId, entry);

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
        this.evict(id).catch(() => {});
      }
    }
  }
}
