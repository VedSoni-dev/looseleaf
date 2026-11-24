/** Same-origin check for every route that changes state or spends credit (POST /api/ai, the gate's POSTs and
 *  DELETE). Ported from Linework (Inkling before it). The cookies are SameSite=Lax, so another site can't spend anyone's credit with them;
 *  but a cross-site form POST is a top-level navigation, and its answer may still SET cookies (a fresh install that
 *  signs the person out, or a switch to My own key). So:
 *  - Sec-Fetch-Site "cross-site" or "same-site" (another subdomain) is refused
 *  - an Origin header that isn't this host is refused, including "null" (a sandboxed frame, a data: page)
 *  A request with neither header (curl, a server) passes: it carries no browser's cookies, and the routes answer
 *  strangers on their own (401 on /api/ai). */
export function foreignOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  if (origin === "null") return true;
  let host: string;
  try { host = new URL(origin).host; } catch { return true; }
  const own = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host).split(",")[0]!.trim();
  return host.toLowerCase() !== own.toLowerCase();
}

export const forbidden = () =>
  Response.json({ error: { message: "This request came from another site, so Looseleaf refused it. Open Looseleaf itself and try there." } }, { status: 403, headers: { "cache-control": "no-store" } });
