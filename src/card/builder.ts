/**
 * Card builder for Feishu Interactive Cards.
 *
 * Builds card JSON for streaming and completed states, using
 * CardKit for typewriter-effect streaming updates.
 */

import type { CardFooterMetrics } from "./types.js";
import { STREAMING_ELEMENT_ID, FOOTER_ELEMENT_ID } from "./types.js";

// ---- Streaming card (initial state, before any text) ----

/**
 * Build the initial streaming card.
 * This card is created via CardKit and sent as an IM message,
 * then updated in-place via cardElement.content().
 */
export function buildStreamingCard(): Record<string, unknown> {
  return {
    header: {
      title: { tag: "plain_text", content: "🤖 思考中…" },
    },
    elements: [
      {
        tag: "markdown",
        content: "",
        element_id: STREAMING_ELEMENT_ID,
      },
      {
        tag: "hr",
      },
      {
        tag: "markdown",
        content: "⏳ 生成中…",
        element_id: FOOTER_ELEMENT_ID,
      },
    ],
  };
}

// ---- Complete card (final state) ----

export interface CompleteCardOptions {
  text: string;
  isError?: boolean;
  isAborted?: boolean;
  elapsedMs?: number;
  footer?: CardFooterMetrics;
}

/**
 * Build the final card after streaming completes / errors / aborts.
 */
export function buildCompleteCard(opts: CompleteCardOptions): Record<string, unknown> {
  const { text, isError, isAborted, elapsedMs, footer } = opts;

  const title = isAborted
    ? "⛔ 已中止"
    : isError
      ? "❌ 错误"
      : "✅ 完成";

  const headerColor = isAborted
    ? "yellow"
    : isError
      ? "red"
      : "green";

  const footerLines = buildFooterLines(elapsedMs, footer);

  return {
    header: {
      title: { tag: "plain_text", content: title },
      template: headerColor,
    },
    elements: [
      {
        tag: "markdown",
        content: text || "(空回复)",
      },
      ...(footerLines.length > 0
        ? [
            { tag: "hr" },
            { tag: "markdown", content: footerLines.join("  ·  ") },
          ]
        : []),
    ],
  };
}

// ---- Footer helpers ----

function formatElapsed(ms: number, icon = "⏱"): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return `${icon} ${totalSec.toFixed(1)}s`;
  }
  const mins = totalSec / 60;
  return `${icon} ${mins.toFixed(1)}m`;
}

function buildFooterLines(elapsedMs?: number, footer?: CardFooterMetrics): string[] {
  const lines: string[] = [];

  // Session duration (since session creation)
  if (footer?.sessionElapsedMs !== undefined) {
    lines.push(formatElapsed(footer.sessionElapsedMs, "⏱"));
  }
  // Request elapsed time (agent execution for this request)
  if (elapsedMs !== undefined) {
    lines.push(formatElapsed(elapsedMs, "⚡"));
  }
  if (footer?.sessionName) {
    lines.push(`📋 ${footer.sessionName}`);
  }
  if (footer?.model) {
    lines.push(`🧠 ${footer.model}`);
  }
  // Always show input/output tokens in K units
  if (footer?.inputTokens !== undefined && footer?.outputTokens !== undefined) {
    lines.push(`📊 ${formatToken(footer.inputTokens)} → ${formatToken(footer.outputTokens)}`);
  } else {
    if (footer?.inputTokens !== undefined) {
      lines.push(`⬆️ ${formatToken(footer.inputTokens)}`);
    }
    if (footer?.outputTokens !== undefined) {
      lines.push(`⬇️ ${formatToken(footer.outputTokens)}`);
    }
  }
  if (footer?.tokens !== undefined && footer?.inputTokens === undefined && footer?.outputTokens === undefined) {
    lines.push(`📊 ${formatToken(footer.tokens)}`);
  }

  return lines;
}

function formatToken(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// ---- Streaming content builder ----

/**
 * Build the streaming content for a given element.
 * Used with CardKit cardElement.content() API.
 */
export function buildStreamingFooterContent(
  elapsedMs: number,
  toolStatus?: string,
  sessionElapsedMs?: number,
): string {
  const icon = sessionElapsedMs !== undefined ? "⏱" : "⚡";
  let content = formatElapsed(sessionElapsedMs ?? elapsedMs, icon);
  if (toolStatus) {
    content += `  ·  ${toolStatus}`;
  }
  return content;
}
