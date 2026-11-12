import { cookies } from "next/headers";
import { forget, gateStatus } from "@/lib/publik";

/** Looseleaf 0.1.2 kept an unsealed publik key in this cookie. This browser now gets a sealed install instead. */
const LEGACY_COOKIE = "ll_publik";

/** Creates this browser's publik install (POST /api/v1/installs) when it has none, seals its key into
 *  an http-only cookie, and answers the gate's next screen. The key never appears in the response. */
export async function POST(req: Request) {
  const jar = await cookies();
  if (jar.has(LEGACY_COOKIE)) jar.delete(LEGACY_COOKIE);
  const status = await gateStatus(jar, req, { provision: true });
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}

/** Forget this browser's install and choice. The next visit starts at Sign in with publik again. */
export async function DELETE() {
  forget(await cookies());
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
