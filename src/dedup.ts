/**
 * Bounded LRU cache for Feishu message deduplication.
 *
 * Feishu may retry the same event_id; we drop replays.
 */

export class DedupCache {
	private map = new Map<string, number>();
	constructor(
		private readonly maxEntries = 5000,
		private readonly ttlMs = 10 * 60 * 1000,
	) {}

	/** Returns true if id was new (and recorded). False if already seen. */
	check(id: string): boolean {
		const now = Date.now();
		this.gc(now);
		const seen = this.map.get(id);
		if (seen !== undefined && now - seen < this.ttlMs) {
			// refresh recency
			this.map.delete(id);
			this.map.set(id, seen);
			return false;
		}
		this.map.set(id, now);
		if (this.map.size > this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
		return true;
	}

	private gc(now: number) {
		if (this.map.size < this.maxEntries / 2) return;
		const cutoff = now - this.ttlMs;
		for (const [k, v] of this.map) {
			if (v < cutoff) this.map.delete(k);
			else break; // insertion order ⇒ first not-expired ends scan
		}
	}
}
