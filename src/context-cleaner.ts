/**
 * Mid-session tool result context cleaner.
 *
 * Two strategies work together:
 *   1. Per-result truncation — large single results get head+tail trimmed (cleanToolResult)
 *   2. Cross-result collapse — keeps only first N + last N tool results per session;
 *      middle ones are replaced with a placeholder (collapseToolResults)
 *
 * Hooks:
 *   1. afterToolCall (before writing to state / JSONL)
 *   2. transformContext (before LLM call, safety net for restored sessions)
 *
 * Skipped tool types (per-result truncation):
 *   - bash / code execution (contain command output user needs to see)
 *   - grep / search (already summarized by the tool itself)
 *   - edit / write (short confirmation messages, not worth processing)
 */

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContextCleanerOptions {
  /** Token threshold above which truncation kicks in (default: 4000). */
  maxTokens: number;
  /** Tokens to keep from the head (default: 1000). */
  headTokens: number;
  /** Tokens to keep from the tail (default: 2000). */
  tailTokens: number;
}

const DEFAULT_OPTIONS: ContextCleanerOptions = {
  maxTokens: 1500,
  headTokens: 500,
  tailTokens: 1000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tool names whose results should NEVER be truncated.
 *
 * Most of these already produce compact output (edit/write: confirmation lines,
 * grep/search: already summarized by the tool). bash is excluded from this list
 * because command output can be enormous (100K+ tokens). We still keep bash
 * results intact up to the maxTokens threshold.
 */
const SKIP_TOOLS = new Set([
  "grep",
  "code_search",
  "web_search",
  "search",
  "edit",
  "write",
]);

function shouldSkip(toolName: string): boolean {
  return SKIP_TOOLS.has(toolName);
}

/** Extract all text from content blocks. */
function extractAllText(
  content: ({ type: string; text?: string } | { type: string; data?: string })[]
): string {
  return content
    .map((b) => {
      if (b.type === "text") return (b as { type: "text"; text: string }).text ?? "";
      return "";
    })
    .join("\n");
}

/** Rebuild content blocks from truncated text. */
function rebuildContent(
  originalContent: ({ type: string; text?: string } | { type: string; data?: string })[],
  newText: string
): { type: "text"; text: string }[] {
  const hasImages = originalContent.some((b) => b.type === "image");
  if (!hasImages) {
    return [{ type: "text" as const, text: newText }];
  }
  const result: { type: "text"; text: string }[] = [{ type: "text", text: newText }];
  for (const block of originalContent) {
    if (block.type === "image") {
      result.push(block as any);
    }
  }
  return result;
}

/**
 * Truncate a single tool result message.
 * Returns the same message if no truncation is needed.
 */
export function cleanToolResult(
  msg: any,
  options: Partial<ContextCleanerOptions> = {}
): any {
  if (msg.role !== "toolResult") return msg;

  const opts = { ...DEFAULT_OPTIONS, ...options };
  const toolName: string = msg.toolName ?? "";

  if (shouldSkip(toolName)) return msg;
  if (msg.isError) return msg;

  const content = msg.content as { type: string; text?: string }[];
  const fullText = extractAllText(content);

  const tokenCount = estimateTokens(fullText);
  if (tokenCount <= opts.maxTokens) return msg;

  // ---- Truncation needed ----

  const lines = fullText.split("\n");
  const totalLines = lines.length;

  // Head: first headTokens worth of chars
  const headCharLen = opts.headTokens * CHARS_PER_TOKEN;
  let headText = "";
  let headLineCount = 0;
  let headChars = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (headChars + lineLen > headCharLen) break;
    headText += line + "\n";
    headChars += lineLen;
    headLineCount++;
  }
  headText = headText.replace(/\n$/, "");

  // Tail: last tailTokens worth of chars
  const tailCharLen = opts.tailTokens * CHARS_PER_TOKEN;
  const tailLines: string[] = [];
  let tailChars = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const lineLen = line.length + 1;
    if (tailChars + lineLen > tailCharLen) break;
    tailLines.unshift(line);
    tailChars += lineLen;
  }
  const tailText = tailLines.join("\n");
  const tailLineStart = totalLines - tailLines.length + 1;

  const remainingLines = totalLines - headLineCount - tailLines.length;
  const truncationNotice = `\n... [${remainingLines} lines truncated (lines ${headLineCount + 1}-${tailLineStart - 1}), total ${totalLines} lines, ~${tokenCount} tokens] ...\n`;

  return {
    ...msg,
    content: rebuildContent(content, headText + truncationNotice + tailText),
  };
}

/**
 * Process messages list, truncating large tool results.
 * Designed to be used as a transformContext wrapper.
 */
export function cleanToolResults(
  messages: any[],
  options: Partial<ContextCleanerOptions> = {}
): any[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return messages.map((msg) => cleanToolResult(msg, opts));
}

/** Placeholder text for collapsed middle tool results. */
const COLLAPSED_PLACEHOLDER = "[tool result collapsed — context management]";

/**
 * Collapse tool results in the middle of the conversation, keeping:
 *   1. The first `keepFirst` tool results — forms a stable cache prefix.
 *   2. Tool results from the last `keepTurns` assistant turns — preserves
 *      recent context without shifting boundaries every turn.
 *
 * Middle results are replaced with a short placeholder.
 *
 * Using turn boundaries instead of a trailing count avoids per-turn cache
 * invalidation: the set of "recent turn" tool results only changes when a
 * new assistant turn completes AND the oldest tracked turn drops off,
 * rather than on every new tool result.
 *
 * Only affects messages already stored in state — does NOT trigger JSONL rewrites.
 */
export function collapseToolResults(
  messages: any[],
  keepFirst: number = 40,
  keepTurns: number = 1
): any[] {
  // Find toolResult and assistant message positions
  const toolResultIndices: number[] = [];
  const assistantIndices: number[] = [];
  messages.forEach((msg, i) => {
    if (msg?.role === "toolResult") toolResultIndices.push(i);
    if (msg?.role === "assistant") assistantIndices.push(i);
  });

  // No collapse needed if total tool results ≤ keepFirst
  if (toolResultIndices.length <= keepFirst) return messages;

  // Keep first `keepFirst` (stable cache prefix)
  const keep = new Set(toolResultIndices.slice(0, keepFirst));

  // Keep all tool results from the last `keepTurns` assistant turns
  if (assistantIndices.length > 0 && keepTurns > 0) {
    const recentAssistantStart = Math.max(0, assistantIndices.length - keepTurns);
    const cutoffIdx = assistantIndices[recentAssistantStart]!;
    for (const idx of toolResultIndices) {
      if (idx >= cutoffIdx) keep.add(idx);
    }
  }

  return messages.map((msg, i) => {
    if (msg?.role !== "toolResult") return msg;
    if (keep.has(i)) return msg;
    return {
      ...msg,
      content: [{ type: "text" as const, text: COLLAPSED_PLACEHOLDER }],
    };
  });
}

// ---------------------------------------------------------------------------
// Cross-result collapse — keep first N + last N tool results
