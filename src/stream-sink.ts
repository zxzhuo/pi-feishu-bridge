/**
 * Stream output throttler.
 *
 * Coalesces high-frequency text/thinking deltas into a small number of
 * Feishu `updateMessage` calls. Honors both an interval (ms) and a chunk
 * size (chars). Flushes immediately on completion.
 */

export interface StreamSinkOptions {
	flushMs: number;
	flushChars: number;
	onFlush: (text: string, isFinal: boolean) => Promise<void> | void;
}

export class StreamSink {
	private buffer = "";
	private lastFlushedLen = 0;
	private timer: NodeJS.Timeout | null = null;
	private inflight: Promise<void> | null = null;
	private closed = false;

	constructor(private readonly opts: StreamSinkOptions) {}

	append(delta: string) {
		if (this.closed || !delta) return;
		this.buffer += delta;
		const grew = this.buffer.length - this.lastFlushedLen;
		if (grew >= this.opts.flushChars) {
			void this.flush(false);
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush(false);
			}, this.opts.flushMs);
		}
	}

	/** Replace the entire buffer (e.g. when assistant produces a new content block). */
	replace(text: string) {
		if (this.closed) return;
		this.buffer = text;
		void this.flush(false);
	}

	async finish(finalText?: string) {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (finalText !== undefined) this.buffer = finalText;
		await this.flush(true);
	}

	private async flush(isFinal: boolean) {
		if (this.inflight) {
			// Coalesce concurrent flushes — wait for inflight, then flush latest.
			await this.inflight.catch(() => {});
		}
		const snapshot = this.buffer;
		if (!isFinal && snapshot.length === this.lastFlushedLen) return;
		this.lastFlushedLen = snapshot.length;
		this.inflight = Promise.resolve(this.opts.onFlush(snapshot, isFinal))
			.catch((err) => {
				// We swallow flush errors — the next flush will retry with newer content.
				// eslint-disable-next-line no-console
				console.error("[stream] flush failed:", err);
			})
			.finally(() => {
				this.inflight = null;
			});
		await this.inflight;
	}
}
