/**
 * Trigger word detection for fast abort.
 *
 * Mirrors `~/.forceclaw/extensions/openclaw-lark/src/channel/abort-detect.js`.
 */

const ABORT_TRIGGERS = new Set([
	"stop",
	"esc",
	"abort",
	"wait",
	"exit",
	"interrupt",
	"cancel",
	"halt",
	"停",
	"停一下",
	"停下",
	"停止",
	"取消",
	"打住",
	"等等",
	"中断",
]);

const PUNCT_TRAIL = /[\s.!?\u3002\uFF01\uFF1F\uFF0C,:;。！？]+$/u;

export function isAbortTrigger(text: string): boolean {
	if (!text) return false;
	const stripped = text.replace(PUNCT_TRAIL, "").trim().toLowerCase();
	if (!stripped) return false;
	if (ABORT_TRIGGERS.has(stripped)) return true;
	// Allow short prefixes like "stop please" / "等等先" — only the leading token.
	const firstToken = stripped.split(/\s+/)[0] ?? "";
	return ABORT_TRIGGERS.has(firstToken);
}
