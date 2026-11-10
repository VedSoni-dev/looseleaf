import { cookies } from "next/headers";
import { COOKIE, MODELS, resolvePublikKey } from "@/lib/publik";

export const maxDuration = 60;

interface InMessage {
  role: "user" | "assistant";
  text: string;
  image?: string;
}

interface OwnKey {
  kind: "openai" | "anthropic" | "custom";
  key: string;
  model?: string;
  baseURL?: string;
}

const SYSTEM = [
  "You are the study assistant inside Looseleaf, a handwriting notebook app.",
  "The image is the user's own handwritten page, or the part of it they circled. Read the handwriting carefully, including maths and diagrams.",
  "Answer directly and briefly. Use plain text with light Markdown only: short headings, bullet lists, **bold**.",
  "Never use LaTeX. Write maths with ordinary characters and Unicode (x², √, ÷, ≤, π).",
  "If the handwriting is unreadable or the image is blank, say so plainly instead of guessing.",
].join(" ");

const OWN_DEFAULTS = {
  openai: { url: "https://api.openai.com/v1/chat/completions", model: "gpt-5-mini" },
  anthropic: { url: "https://api.anthropic.com/v1/chat/completions", model: "claude-sonnet-5-5" },
} as const;

function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: { message, ...extra } }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  let body: { messages?: InMessage[]; own?: OwnKey | null };
  try {
    body = await request.json();
  } catch {
    return fail(400, "That request was not valid JSON.");
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-24) : [];
  if (!messages.length) return fail(400, "Nothing to ask yet.");
  let bytes = 0;
  for (const m of messages) {
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return fail(400, "Malformed message.");
    if (m.image !== undefined && (typeof m.image !== "string" || !m.image.startsWith("data:image/"))) return fail(400, "Malformed image.");
    bytes += m.text.length + (m.image?.length ?? 0);
  }
  if (bytes > 3_600_000) return fail(413, "That page is too large to send. Try lassoing a smaller part.");

  // 1. The user's own key always wins. 2. Otherwise publik API.
  let url: string;
  let apiKey: string;
  let model: string;
  let viaPublik = false;
  const own = body.own;
  if (own?.key) {
    if (own.kind === "custom") {
      if (process.env.LOOSELEAF_ALLOW_CUSTOM_BASE !== "1" || !own.baseURL) return fail(400, "Custom endpoints are turned off on this server.");
      url = `${own.baseURL.replace(/\/+$/, "")}/chat/completions`;
      model = own.model || "default";
    } else if (own.kind === "openai" || own.kind === "anthropic") {
      url = OWN_DEFAULTS[own.kind].url;
      model = own.model?.trim() || OWN_DEFAULTS[own.kind].model;
    } else {
      return fail(400, "Unknown key type.");
    }
    apiKey = own.key;
  } else {
    const jar = await cookies();
    const publik = resolvePublikKey(jar.get(COOKIE)?.value);
    if (!publik) return fail(401, "Turn on AI first.", { code: "needs_consent" });
    url = `${publik.baseURL}/chat/completions`;
    apiKey = publik.apiKey;
    model = MODELS.balanced;
    viaPublik = true;
  }

  const upstreamBody = {
    model,
    stream: true,
    messages: [
      { role: "system", content: SYSTEM },
      ...messages.map((m) => ({
        role: m.role,
        content: m.image
          ? [
              { type: "text", text: m.text },
              { type: "image_url", image_url: { url: m.image } },
            ]
          : m.text,
      })),
    ],
  };

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
      signal: request.signal,
    });
  } catch {
    return fail(502, viaPublik ? "Could not reach publik API. Check your connection and try again." : "Could not reach your AI provider.");
  }

  const passthrough = new Headers({ "cache-control": "no-store" });
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-publik-")) passthrough.set(name, value);
  });
  passthrough.set("x-looseleaf-provider", viaPublik ? "publik" : "own");

  if (!upstream.ok || !upstream.body) {
    const raw = await upstream.text().catch(() => "");
    let message = "";
    let topUp: string | undefined;
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message ?? "";
      topUp = parsed?.error?.top_up_url;
    } catch {}
    if (!message) {
      message =
        upstream.status === 401 ? (viaPublik ? "publik API did not accept this install. Turn AI on again." : "Your provider rejected that API key.")
        : upstream.status === 429 ? "Rate limited. Give it a few seconds and try again."
        : `The AI provider answered ${upstream.status}.`;
    }
    return Response.json(
      { error: { message, top_up_url: viaPublik ? topUp : undefined, code: upstream.status === 402 ? "balance" : undefined } },
      { status: upstream.status === 200 ? 502 : upstream.status, headers: passthrough },
    );
  }

  passthrough.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  return new Response(upstream.body, { status: 200, headers: passthrough });
}
