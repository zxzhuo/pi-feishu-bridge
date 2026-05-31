/**
 * Simple leveled logger for pi-feishu-bridge.
 *
 * Respects the logLevel from config. Exports a singleton `log`
 * that is configured once on startup.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export class Logger {
  private level: number;

  constructor(level: LogLevel = "info") {
    this.level = LOG_LEVELS[level];
  }

  debug(...args: unknown[]) {
    if (this.level <= 0) console.log("[debug]", ...args);
  }
  info(...args: unknown[]) {
    if (this.level <= 1) console.log("[info]", ...args);
  }
  warn(...args: unknown[]) {
    if (this.level <= 2) console.warn("[warn]", ...args);
  }
  error(...args: unknown[]) {
    if (this.level <= 3) console.error("[error]", ...args);
  }
}

let _instance: Logger | null = null;

/** Get the global logger instance. Defaults to "info" until configured. */
export function getLogger(): Logger {
  if (!_instance) _instance = new Logger("info");
  return _instance;
}

/** Initialize the global logger with a level. Call once at startup. */
export function initLogger(level: LogLevel): void {
  _instance = new Logger(level);
}
