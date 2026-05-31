/**
 * Natural language session matching — no LLM, all code.
 *
 * Parses user commands like:
 *   "切换到 models 项目"
 *   "切到昨天下午的会话"
 *   "打开 pi-feishu-bridge 那个"
 *   "看看关于 cache 的会话"
 *
 * Returns structured actions: switch, new, list, or null (not a session command).
 */

import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMatchAction {
  type: "switch" | "new" | "list" | "delete";
  /** Matched session id or path, if any */
  sessionPath?: string;
  /** Matched project name, if any */
  project?: string;
  /** Human-readable confirmation message */
  message: string;
}

export interface SessionMeta {
  path: string;
  id: string;
  /** project name recorded in session header */
  project?: string;
  /** display name set via /name */
  sessionName?: string;
  /** first user message text */
  firstMessage?: string;
  /** creation timestamp */
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Chinese date/time patterns
// ---------------------------------------------------------------------------

/** Parse relative time expressions into a Date range. */
function parseRelativeTime(text: string): { after: Date; before: Date } | null {
  const now = new Date();

  // "今天" — today
  if (/今天/.test(text)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { after: start, before: now };
  }

  // "昨天" — yesterday
  if (/昨天/.test(text)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { after: start, before: end };
  }

  // "前天" 
  if (/前天/.test(text)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 2);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { after: start, before: end };
  }

  // "N 小时前" / "刚刚"
  const minsAgo = text.match(/(\d+)\s*分(钟)?前/);
  if (minsAgo && minsAgo[1]) {
    const start = new Date(now.getTime() - parseInt(minsAgo[1]) * 60_000);
    return { after: start, before: now };
  }

  const hoursAgo = text.match(/(\d+)\s*小(时)?前/);
  if (hoursAgo && hoursAgo[1]) {
    const start = new Date(now.getTime() - parseInt(hoursAgo[1]) * 3_600_000);
    return { after: start, before: now };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Stop words to strip from the query. */
const STOP_WORDS = new Set([
  "切换", "切到", "切换到", "打开", "看看", "那个", "会话",
  "到", "的", "了", "是", "在", "有", "和", "或", "这", "那",
  "一个", "什么", "哪个", "关于", "最近", "之前", "以前",
  "帮我", "请", "一下",
]);

/** Extract meaningful keywords from natural language text. */
function extractKeywords(text: string): string[] {
  // Normalize
  let cleaned = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, " ")  // keep Chinese chars + alnum
    .replace(/\s+/g, " ")
    .trim();

  // Remove stop words
  for (const word of STOP_WORDS) {
    cleaned = cleaned.replace(new RegExp(word, "g"), " ");
  }

  return cleaned
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

function score(a: string, b: string): number {
  if (!a || !b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  // Exact match
  if (al === bl) return 100;
  // Contains
  if (al.includes(bl) || bl.includes(al)) return 80;
  // Substring
  if (al.includes(bl.slice(0, Math.max(3, bl.length >> 1)))) return 60;
  // Word overlap
  const aWords = new Set(al.split(/[^a-z0-9\u00e0-\u024f]+/).filter(Boolean));
  const bWords = bl.split(/[^a-z0-9\u00e0-\u024f]+/).filter(Boolean);
  const overlap = bWords.filter((w) => aWords.has(w)).length;
  if (overlap > 0) return (overlap / Math.max(bWords.length, 1)) * 50;

  return 0;
}

/** Score a session against keywords. Returns 0-100. */
function scoreSession(meta: SessionMeta, keywords: string[]): number {
  let maxScore = 0;
  for (const kw of keywords) {
    const fields = [
      meta.project ?? "",
      meta.sessionName ?? "",
      meta.firstMessage ?? "",
    ];
    for (const field of fields) {
      maxScore = Math.max(maxScore, score(field, kw));
    }
  }
  return maxScore;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

function classifyIntent(text: string): "switch" | "new" | "list" | "delete" | null {
  if (/新建|新会话|创建|新(的)?项目/.test(text)) return "new";
  if (/删除|删除会话|移除/.test(text)) return "delete";
  if (/切换|切到|切换到|打开|看看.*会话|列出|所有会话/.test(text)) return "switch";
  // Pure session switch intent — no explicit verb, but mentions project/session names
  if (/项目|会话|那[个些]/.test(text)) return "switch";
  return null;
}

function isListIntent(text: string): boolean {
  return /列出|有哪些|所有会话|最近会话|sessions\b/.test(text);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Try to parse a natural language session command.
 * Returns null if the text doesn't look like a session management command.
 */
export async function matchSessionCommand(
  text: string,
  sessionDir: string,
  cwd: string,
  activeProject: string
): Promise<SessionMatchAction | null> {
  const trimmed = text.trim();

  // 1. Detect intent
  const intent = classifyIntent(trimmed);
  if (!intent && !isListIntent(trimmed)) return null;

  // /list intent
  if (isListIntent(trimmed) || intent === "list") {
    return { type: "list", message: "" };
  }

  // /new intent
  if (intent === "new") {
    const project = extractProject(trimmed) ?? activeProject;
    return {
      type: "new",
      project,
      message: `🆕 新建${project !== activeProject ? ` "${project}" 项目` : ""}会话`,
    };
  }

  // /delete intent
  if (intent === "delete") {
    return { type: "delete", message: "请用 /sessions 查看列表后用序号删除" };
  }

  // 2. Extract time range
  const timeRange = parseRelativeTime(trimmed);

  // 3. Load sessions
  let sessions: SessionInfo[];
  try {
    sessions = await SessionManager.list(cwd, sessionDir);
  } catch {
    return null;
  }

  if (sessions.length === 0) {
    return { type: "new", message: "没有历史会话，创建一个新的？" };
  }

  // 4. Build session metadata
  const metas: SessionMeta[] = sessions.map((s) => ({
    path: s.path,
    id: s.id,
    project: "", // project info from session header, not available via generic SessionInfo
    sessionName: s.name ?? "",
    firstMessage: (s as any).firstMessage ?? "",
    timestamp: s.created instanceof Date ? s.created : new Date(s.created ?? Date.now()),
  }));

  // 5. Filter by time range
  let candidates = metas;
  if (timeRange) {
    candidates = metas.filter(
      (m) => m.timestamp >= timeRange.after && m.timestamp <= timeRange.before
    );
    if (candidates.length === 0) {
      return { type: "list", message: "该时间段没有找到会话" };
    }
  }

  // 6. Extract keywords and score
  const keywords = extractKeywords(trimmed);
  if (keywords.length === 0 && !timeRange) {
    // No meaningful keywords — can't match
    return null;
  }

  const scored = candidates
    .map((m) => ({ meta: m, score: scoreSession(m, keywords) }))
    .filter((s) => s.score >= 30) // threshold
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  // 7. Pick best match
  const best = scored[0]!;
  const confirmMsg =
    best.score >= 80
      ? `✅ 切换到会话${best.meta.sessionName ? `「${best.meta.sessionName}」` : ""}`
      : `🔀 最匹配的是${best.meta.sessionName ? `「${best.meta.sessionName}」` : ""}，要切换吗？`;

  return {
    type: "switch",
    sessionPath: best.meta.path,
    project: best.meta.project,
    message: confirmMsg,
  };
}

/** Extract a project name from the text (e.g. "切换到 models 项目" → "models"). */
function extractProject(text: string): string | null {
  const match = text.match(/(?:切换到?|打开|看看)\s+([a-zA-Z0-9_-]+)\s*(?:项目)?/);
  return match?.[1] ?? null;
}
