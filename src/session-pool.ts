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
  createAgentSessionRuntime,
  AgentSessionRuntime,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

export interface PoolEntry {
  runtime: AgentSessionRuntime;
  chatId: string;
  lastUsedAt: number;
  healthy: boolean;
  unsubscribe?: () => void;
}

export interface SessionPoolOptions {
  sessionBaseDir: string;
  cwdBaseDir: string;
  sessionIdleMs: number;
  maxSessions: number;
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
    e.unsubscribe?.();
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

    // We use createAgentSessionRuntime directly.
    // The factory is called once here to create the first session.
    const factory: CreateAgentSessionRuntimeFactory = async (factoryOpts) => {
      const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
      const result = await createAgentSession({
        cwd: factoryOpts.cwd,
        sessionManager: factoryOpts.sessionManager,
      });
      return { ...result, services: (result as any).services ?? {}, diagnostics: [] };
    };

    const runtime = await createAgentSessionRuntime(factory, {
      cwd,
      agentDir: path.join(this.opts.sessionBaseDir, ".agent"),
      sessionManager: SessionManager.continueRecent(cwd, sessionDir),
    });

    const entry: PoolEntry = {
      runtime,
      chatId,
      lastUsedAt: Date.now(),
      healthy: true,
    };

    // Subscribe to extension errors via the runner — separate from the
    // AgentSessionEvent stream.
    const runner = (runtime.session as any).extensionRunner;
    let unsubExtErr: (() => void) | undefined;
    if (typeof runner?.onError === "function") {
      unsubExtErr = runner.onError((err: any) => {
        this.opts.onError?.(chatId, err?.error ?? String(err));
      });
    }
    entry.unsubscribe = () => {
      unsubExtErr?.();
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
