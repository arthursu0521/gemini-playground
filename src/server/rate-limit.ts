/**
 * Fixed-window rate limiter keyed by client IP. State lives in the isolate's memory, so on
 * multi-instance platforms the limit is per instance (best effort). Put a platform rate-limit
 * rule in front for hard guarantees.
 */
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
}

export class RateLimiter {
    readonly #limit: number;
    readonly #windowMs: number;
    readonly #now: () => number;
    readonly #maxKeys: number;
    #windows = new Map<string, { start: number; count: number }>();

    /** @param limit requests per window; 0 disables limiting. */
    constructor(limit: number, options: { windowMs?: number; now?: () => number; maxKeys?: number } = {}) {
        this.#limit = limit;
        this.#windowMs = options.windowMs ?? 60_000;
        this.#now = options.now ?? Date.now;
        this.#maxKeys = options.maxKeys ?? 10_000;
    }

    take(key: string): RateLimitResult {
        if (this.#limit <= 0) return { allowed: true, remaining: Infinity, retryAfterSeconds: 0 };
        const now = this.#now();
        let entry = this.#windows.get(key);
        if (!entry || now - entry.start >= this.#windowMs) {
            if (!entry && this.#windows.size >= this.#maxKeys) this.#prune(now);
            entry = { start: now, count: 0 };
            this.#windows.set(key, entry);
        }
        entry.count++;
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.start + this.#windowMs - now) / 1000));
        if (entry.count > this.#limit) return { allowed: false, remaining: 0, retryAfterSeconds };
        return { allowed: true, remaining: this.#limit - entry.count, retryAfterSeconds: 0 };
    }

    get size(): number {
        return this.#windows.size;
    }

    #prune(now: number) {
        for (const [key, entry] of this.#windows) {
            if (now - entry.start >= this.#windowMs) this.#windows.delete(key);
        }
        // Still full (an attack with many IPs): drop the oldest entries.
        if (this.#windows.size >= this.#maxKeys) {
            const excess = this.#windows.size - Math.floor(this.#maxKeys / 2);
            let i = 0;
            for (const key of this.#windows.keys()) {
                if (i++ >= excess) break;
                this.#windows.delete(key);
            }
        }
    }
}
