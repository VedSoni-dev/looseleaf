import { cookies } from "next/headers";
import { sendUsage, USAGE_EVENTS, type UsageEvent } from "@/lib/publik";

/** Usage counting, sent from this server to publik with this browser's install key:
 *  { event: "app_opened" } once per browser session, then { event: "active_session" } every 30 minutes. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { event?: unknown };
  const event = USAGE_EVENTS.find((e) => e === body.event) as UsageEvent | undefined;
  if (!event) return Response.json({ error: { message: "Unknown event." } }, { status: 400 });
  const result = await sendUsage(await cookies(), req, event);
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
