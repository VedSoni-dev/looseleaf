import { cookies } from "next/headers";
import { COOKIE, DISCLOSURE, hasAppToken, resolvePublikKey } from "@/lib/publik";

/** Tells the AI panel which first-run state to show. Never returns a key. */
export async function GET() {
  const jar = await cookies();
  const connected = !!resolvePublikKey(jar.get(COOKIE)?.value);
  return Response.json(
    { connected, available: connected || hasAppToken(), disclosure: DISCLOSURE },
    { headers: { "cache-control": "no-store" } },
  );
}
