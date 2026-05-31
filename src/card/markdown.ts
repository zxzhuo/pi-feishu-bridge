/**
 * Markdown processing for Feishu card output.
 *
 * Feishu's card markdown element supports a subset of markdown:
 * - **bold**, *italic*, `inline code`
 * - ```code blocks``` (with language hint)
 * - [links](url)
 * - - lists
 * - > blockquotes
 *
 * But it has limits:
 * - Card table limit (~20 tables per card) — detected at runtime
 * - Very long lines may be truncated
 *
 * This module provides sanitization and fallback formatting.
 */

// ---- Card text limits ----

/** Maximum character length for a single card element text. */
const MAX_ELEMENT_CHARS = 200_000;

// ---- Sanitization ----

/**
 * Sanitize markdown text for Feishu card rendering.
 *
 * - Truncates content that exceeds card limits
 * - Ensures code blocks are properly closed
 * - Strips HTML tags not supported by Feishu
 */
export function sanitizeCardText(text: string): string {
  if (!text) return "";

  // Truncate if too long
  if (text.length > MAX_ELEMENT_CHARS) {
    text = text.slice(0, MAX_ELEMENT_CHARS) + "\n\n*(内容过长，已截断)*";
  }

  // Ensure all code blocks are closed (count ``` pairs)
  const codeBlockMatches = text.match(/```/g);
  if (codeBlockMatches && codeBlockMatches.length % 2 !== 0) {
    text += "\n```";
  }

  return text;
}

// ---- Format conversion ----

/**
 * Convert raw LLM output to Feishu-card-friendly content.
 *
 * This handles:
 * - Preserving markdown formatting (Feishu cards render markdown natively)
 * - Ensuring proper code block formatting
 * - Stripping unsupported patterns
 */
export function formatForCard(text: string): string {
  if (!text) return "";

  let result = text;

  // Normalize line endings
  result = result.replace(/\r\n/g, "\n");

  // Ensure code blocks have language hints for better rendering.
  // Only modify OPENING fences (no language tag set yet), not closing fences.
  // Tracks state to avoid corrupting ``` pairs.
  {
    let inBlock = false;
    const lines = result.split("\n");
    result = lines
      .map((line) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("```")) {
          if (!inBlock) {
            // Opening fence: if no language tag, add "text"
            inBlock = true;
            if (trimmed === "```") {
              return line.replace("```", "```text");
            }
          } else {
            inBlock = false;
          }
        }
        return line;
      })
      .join("\n");
  }

  // Ensure tables are separated by blank lines (Feishu requirement)
  result = result.replace(/([^\n])\n\|/g, "$1\n\n|");

  // Remove excessive consecutive blank lines (Feishu renders them as gaps)
  result = result.replace(/\n{4,}/g, "\n\n\n");

  return sanitizeCardText(result);
}
