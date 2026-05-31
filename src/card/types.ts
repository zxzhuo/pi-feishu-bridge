/**
 * Card-related types and constants for pi-feishu-bridge.
 */

/** Element IDs used in CardKit streaming cards. */
export const STREAMING_ELEMENT_ID = "streaming_content";
export const FOOTER_ELEMENT_ID = "footer_content";

/** Maximum byte length for card text content. */
export const CARD_TEXT_LIMIT = 200 * 1024;

/** Throttle interval for streaming card updates (ms). */
export const STREAM_CARD_THROTTLE_MS = 350;

/** Footer metrics displayed in the card footer. */
export interface CardFooterMetrics {
  model?: string;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  /** Current session display name, if any. */
  sessionName?: string;
  /** Session duration in ms (time since session was created). */
  sessionElapsedMs?: number;
}
