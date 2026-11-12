import { cookies } from "next/headers";
import { setChoice, type Choice } from "@/lib/publik";

/** setChoice() for this browser: { choice: "publik" | "own_key" | null }. null asks again at the next gate. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { choice?: unknown };
  const choice = body.choice === "publik" || body.choice === "own_key" ? (body.choice as Choice) : body.choice === null ? null : undefined;
  if (choice === undefined) return Response.json({ error: { message: "choice must be publik, own_key or null." } }, { status: 400 });
  setChoice(await cookies(), req, choice);
  return Response.json({ ok: true, choice }, { headers: { "cache-control": "no-store" } });
}
