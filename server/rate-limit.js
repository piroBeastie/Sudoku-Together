/**
 * Counts failures against a key inside a rolling window.
 *
 * Deliberately counts only failures, not attempts: someone signing in and out
 * repeatedly is not an attack, and locking them out for it would be a bug. A
 * success wipes the key's history entirely.
 */

export function createFailureLimiter({ max, windowMs, now = () => Date.now() }) {
  /** @type {Map<string, { count: number, expiresAt: number }>} */
  const buckets = new Map();

  const live = (key) => {
    const bucket = buckets.get(key);
    if (!bucket) return null;
    if (now() >= bucket.expiresAt) {
      buckets.delete(key);
      return null;
    }
    return bucket;
  };

  return {
    /** True once this key has failed `max` times inside the window. */
    isBlocked(key) {
      return (live(key)?.count ?? 0) >= max;
    },

    /** Records one failure; the window starts at the first of them. */
    recordFailure(key) {
      const bucket = live(key);
      if (bucket) bucket.count += 1;
      else buckets.set(key, { count: 1, expiresAt: now() + windowMs });
    },

    /** A success clears the slate for that key. */
    clear(key) {
      buckets.delete(key);
    },

    /** Drops expired buckets so the map cannot grow without bound. */
    prune() {
      const at = now();
      for (const [key, bucket] of buckets) {
        if (at >= bucket.expiresAt) buckets.delete(key);
      }
      return buckets.size;
    },

    size() {
      return buckets.size;
    },
  };
}
