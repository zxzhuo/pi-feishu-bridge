/**
 * Streaming card controller for Feishu Interactive Cards.
 *
 * Sends an interactive card via IM API and updates it in-place via patch.
 * No CardKit dependency — works without cardkit:card:write permission.
 *
 * Flow: idle -> creating -> streaming -> completed / aborted / error
 */

import {
  STREAM_CARD_THROTTLE_MS,
  type CardFooterMetrics,
} from "./types.js";
import {
  buildCompleteCard,
  type CompleteCardOptions,
} from "./builder.js";

/** Phase of the streaming controller lifecycle. */
type Phase = "idle" | "creating" | "streaming" | "completed" | "aborted" | "error";

export interface StreamControllerDeps {
  client: any; // Lark SDK client
  chatId: string;
}

/**
 * Controls the lifecycle of one streaming interactive card.
 *
 * Usage:
 *   const ctrl = new StreamingController(deps);
 *   // text deltas
 *   await ctrl.onDelta("Hello");
 *   await ctrl.onDelta(" world");
 *   // tool status updates
 *   await ctrl.onToolStatus("🔧 Read file");
 *   // finalize
 *   await ctrl.finalize({ elapsedMs: 12345, footerMetrics: {...} });
 */
export class StreamingController {
  private phase: Phase = "idle";
  private cardMessageId: string | null = null;
  private accumulatedText = "";
  private lastFlushedText = "";
  public startTime = Date.now();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlush = false;
  private currentToolStatus = "";

  constructor(private deps: StreamControllerDeps) {}

  /** The message_id of the card (available after first delta). */
  get messageId(): string | null {
    return this.cardMessageId;
  }

  /** Append a text delta — schedules a throttled card update. */
  async onDelta(text: string): Promise<void> {
    this.accumulatedText += text;
    this.scheduleFlush();
  }

  /** Replace all card content (for follow-up turns). */
  async replaceText(text: string): Promise<void> {
    this.accumulatedText = text;
    this.lastFlushedText = "";
    await this.flushNow();
  }

  /** Update the tool execution status shown in the card. */
  async onToolStatus(status: string): Promise<void> {
    this.currentToolStatus = status;
    // Don't trigger a flush here — status is included in next text flush
    // If no text flush is pending, schedule a lightweight tool-status-only update
    if (!this.pendingFlush && this.cardMessageId) {
      await this.tryPatch();
    }
  }

  /**
   * Finalize the card — replace streaming text with completed state.
   */
  async finalize(opts?: {
    elapsedMs?: number;
    isError?: boolean;
    isAborted?: boolean;
    footerMetrics?: CardFooterMetrics;
  }): Promise<void> {
    this.cancelFlush();

    // Allow fallback processing for "error" and "aborted" states.
    if (this.phase === "completed") return;
    this.phase = opts?.isAborted ? "aborted" : opts?.isError ? "error" : "completed";

    const elapsed = opts?.elapsedMs ?? Date.now() - this.startTime;
    const isError = opts?.isError ?? false;
    const isAborted = opts?.isAborted ?? false;

    if (!this.cardMessageId) {
      // Card was never created — send final text message
      const text = this.accumulatedText ||
        (isError ? "❌ 请求失败" : isAborted ? "⛔ 已中止" : "(空回复)");
      try {
        await this.deps.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: this.deps.chatId,
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
        });
      } catch {}
      return;
    }

    // Update card with final state
    const card = buildCompleteCard({
      text: this.accumulatedText || "(空回复)",
      isError,
      isAborted,
      elapsedMs: elapsed,
      footer: opts?.footerMetrics,
    });

    try {
      await this.deps.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    } catch {
      // Final fallback: send text message
      const text = this.accumulatedText ||
        (isError ? "❌ 请求失败" : isAborted ? "⛔ 已中止" : "(空回复)");
      try {
        await this.deps.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: this.deps.chatId,
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
        });
      } catch {}
    }
  }

  /** Abort the card mid-stream. */
  async abort(): Promise<void> {
    await this.finalize({ isAborted: true });
  }

  // ---- Internal ----

  /** Send or create the initial interactive card. */
  private async ensureCardCreated(): Promise<void> {
    if (this.cardMessageId || this.phase === "creating") return;

    this.phase = "creating";

    try {
      const card = buildCompleteCard({ text: "…" });
      const resp = await this.deps.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: this.deps.chatId,
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
      this.cardMessageId = resp?.data?.message_id ?? null;

      if (this.cardMessageId) {
        this.phase = "streaming";
        this.startTime = Date.now();
      } else {
        this.phase = "error";
      }
    } catch (err: any) {
      console.error("[card] create failed:", err?.response?.data?.msg ?? err?.message ?? err);
      this.phase = "error";
    }
  }

  /** Schedule a throttled card update. */
  private scheduleFlush(): void {
    if (this.pendingFlush) return;
    this.pendingFlush = true;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.pendingFlush = false;
      this.flushNow().catch(() => {});
    }, STREAM_CARD_THROTTLE_MS);
  }

  private cancelFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingFlush = false;
  }

  /** Actually update the card with accumulated text. */
  private async flushNow(): Promise<void> {
    const text = this.accumulatedText;
    if (text === this.lastFlushedText) return;

    await this.ensureCardCreated();
    if (this.phase !== "streaming" || !this.cardMessageId) return;

    this.lastFlushedText = text;
    await this.tryPatch();
  }

  /** Try to patch the card with current accumulated text + tool status. */
  private async tryPatch(): Promise<void> {
    if (!this.cardMessageId) return;

    const displayText = this.accumulatedText +
      (this.currentToolStatus ? `\n\n---\n${this.currentToolStatus}` : "");

    const card = buildCompleteCard({ text: displayText || "…" });

    try {
      await this.deps.client.im.v1.message.patch({
        path: { message_id: this.cardMessageId },
        data: {
          msg_type: "interactive",
          content: JSON.stringify(card),
        },
      });
    } catch (e: any) {
      console.error("[card] patch failed:", e?.response?.data?.msg ?? e?.message ?? e);
    }
  }
}
