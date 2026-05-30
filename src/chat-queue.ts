/**
 * Per-chat serial task queue.
 *
 * Same chatId → enqueued strictly in arrival order.
 * Different chatIds → run in parallel.
 *
 * Mirrors the design of openclaw-lark's `chat-queue.js`.
 */

type Task<T> = () => Promise<T>;

interface Slot {
	tail: Promise<unknown>;
	depth: number;
}

export class ChatQueue {
	private slots = new Map<string, Slot>();

	enqueue<T>(key: string, task: Task<T>): Promise<T> {
		const existing = this.slots.get(key);
		const previous = existing?.tail ?? Promise.resolve();
		const next = previous.then(task, task);
		const slot: Slot = {
			tail: next,
			depth: (existing?.depth ?? 0) + 1,
		};
		this.slots.set(key, slot);
		next.finally(() => {
			const current = this.slots.get(key);
			if (current && current.tail === next) {
				this.slots.delete(key);
			}
		});
		return next;
	}

	depth(key: string): number {
		return this.slots.get(key)?.depth ?? 0;
	}

	has(key: string): boolean {
		return this.slots.has(key);
	}
}
