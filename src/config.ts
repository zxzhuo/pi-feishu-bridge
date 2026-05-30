/**
 * Configuration loader for pi-feishu-bridge.
 * Sources (highest priority wins):
 *   1. Environment variables
 *   2. ~/.config/pi-feishu/config.json
 *   3. Defaults
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** WS (default) | http | both */
  transport: "ws" | "http" | "both";
  /** Directory to store per-chat pi sessions */
  sessionBaseDir: string;
  /** Directory to use as cwd for each pi agent (mapped by chatId) */
  cwdBaseDir: string;
  /** Open IDs allowed to use the bot. Empty = allow all */
  allowedOpenIds: string[];
  /** Whether /think /model etc. are restricted to allowedOpenIds */
  ownerOnly: boolean;
  /** Idle ms before a session is GC'd */
  sessionIdleMs: number;
  /** Max concurrent sessions */
  maxSessions: number;
  /** Throttle: min ms between feishu message edits */
  streamFlushMs: number;
  /** Throttle: min chars added before flush */
  streamFlushChars: number;
  /** Dedup TTL for incoming message ids */
  dedupTtlMs: number;
  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
}

const CONFIG_PATHS = [
  process.env.PI_FEISHU_CONFIG,
  path.join(os.homedir(), ".config", "pi-feishu", "config.json"),
].filter(Boolean) as string[];

function expandEnv(val: string): string {
  return val.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? "");
}

function loadFile(): Partial<Config & Record<string, string>> {
  for (const p of CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(p, "utf8");
      const obj = JSON.parse(raw);
      // expand ${ENV} placeholders in string values
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") obj[k] = expandEnv(v);
      }
      return obj;
    } catch {
      // not found or parse error → try next
    }
  }
  return {};
}

export function loadConfig(): Config {
  const file = loadFile();

  const appId = process.env.FEISHU_APP_ID ?? file.appId ?? "";
  const appSecret = process.env.FEISHU_APP_SECRET ?? file.appSecret ?? "";

  if (!appId || !appSecret) {
    throw new Error(
      "pi-feishu: appId/appSecret missing. Set ~/.config/pi-feishu/config.json or FEISHU_APP_ID/FEISHU_APP_SECRET env vars."
    );
  }

  return {
    appId,
    appSecret,
    transport: (process.env.FEISHU_TRANSPORT as Config["transport"]) ?? file.transport ?? "ws",
    sessionBaseDir:
      process.env.PI_FEISHU_SESSION_DIR ??
      file.sessionBaseDir ??
      path.join(os.homedir(), ".pi-feishu", "sessions"),
    cwdBaseDir:
      process.env.PI_FEISHU_CWD_DIR ??
      file.cwdBaseDir ??
      path.join(os.homedir(), ".pi-feishu", "workspaces"),
    allowedOpenIds: file.allowedOpenIds ?? [],
    ownerOnly: file.ownerOnly ?? false,
    sessionIdleMs: file.sessionIdleMs ?? 30 * 60 * 1000,
    maxSessions: file.maxSessions ?? 20,
    streamFlushMs: file.streamFlushMs ?? 350,
    streamFlushChars: file.streamFlushChars ?? 80,
    dedupTtlMs: file.dedupTtlMs ?? 600_000,
    logLevel: (process.env.PI_FEISHU_LOG_LEVEL as Config["logLevel"]) ?? file.logLevel ?? "info",
  };
}
