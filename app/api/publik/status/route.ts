import { cookies } from "next/headers";
import { gateStatus } from "@/lib/publik";

/** The gate's current screen for this browser. Read only: a browser with no install gets
 *  { state: "needs_install" } and PublikGate then calls POST /api/publik/provision. */
export async function GET(req: Request) {
  const status = await gateStatus(await cookies(), req, { provision: false });
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
