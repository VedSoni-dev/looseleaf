// ratelimit.ts — a small per-client limiter for /api/ai.
//
// Every caller of /api/ai spends only their own publik balance or their own key, so abuse costs
// this server bandwidth and function time, not money. This caps that: a client (by IP) gets
// PER_MINUTE asks a minute and PER_HOUR an hour. State lives in memory, so the limit is per warm
// server instance, not global: enough to stop one script from hammering a single instance, not a
// distributed flood (that would need a shared store such as Vercel KV or Upstash).
const WINDOWS = [
  { ms: 60_000, max: 20 },
  { ms: 60 * 60_000, max: 300 },
] as const;
const MAX_KEYS = 5_000; // bound memory: oldest clients are dropped first

const hits = new Map<string, number[]>();

/** The client's address as Vercel / a proxy reports it. Falls back to one shared bucket. */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

/** Records one ask. Returns null when allowed, else the seconds to wait. */
export function takeToken(key: string, now = Date.now()): number | null {
  const longest = WINDOWS[WINDOWS.length - 1].ms;
  const list = (hits.get(key) ?? []).filter((t) => now - t < longest);
  for (const w of WINDOWS) {
    const inWindow = list.filter((t) => now - t < w.ms);
    if (inWindow.length >= w.max) {
      hits.set(key, list);
      return Math.max(1, Math.ceil((inWindow[0] + w.ms - now) / 1000));
    }
  }
  list.push(now);
  hits.delete(key); // re-insert so Map order tracks recency
  hits.set(key, list);
  if (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value as string);
  return null;
}

/** Tests only. */
export function resetRateLimit() {
  hits.clear();
}
