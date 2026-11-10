import { cookies } from "next/headers";
import { COOKIE, HOSTED, balanceLine, decodeCookie, encodeCookie, provision } from "@/lib/publik";

function osFromUserAgent(ua: string): "macos" | "windows" | "linux" {
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh|iPad|iPhone/i.test(ua)) return "macos";
  return "linux";
}

function deviceFromUserAgent(ua: string): string {
  const device = /iPad/i.test(ua) ? "iPad" : /iPhone/i.test(ua) ? "iPhone" : /Android/i.test(ua) ? "Android" : /Macintosh/i.test(ua) ? "Mac" : /Windows/i.test(ua) ? "Windows PC" : "Browser";
  return `${device} browser`;
}

/** Called only after the user pressed "Turn on AI" under the disclosure text. */
export async function POST(request: Request) {
  const jar = await cookies();
  const ua = request.headers.get("user-agent") ?? "";
  try {
    const credential = await provision({
      prior: decodeCookie(jar.get(COOKIE)?.value),
      os: HOSTED ? osFromUserAgent(ua) : undefined,
      deviceName: HOSTED ? deviceFromUserAgent(ua) : undefined,
    });
    if (HOSTED) {
      jar.set(COOKIE, encodeCookie(credential), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 400,
      });
    }
    // The key itself never goes to the browser's JavaScript.
    return Response.json(
      {
        balance_line: balanceLine(credential.balance_micros, credential.claim_state),
        cost_sentence: credential.cost_sentence,
        claim_state: credential.claim_state,
        claim_url: credential.claim_url,
        add_credit_url: credential.add_credit_url,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "publik API could not set up this browser. Use your own key for now.";
    return Response.json({ error: { message } }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
