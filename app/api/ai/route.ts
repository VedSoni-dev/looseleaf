import { cookies } from "next/headers";
import { MODELS, resolveProvider, topUpUrlFrom402 } from "@/lib/publik";

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
  "The page may be an imported PDF page or lecture slide with the user's handwriting and highlights on top of it: use both, and tell the printed content apart from their notes when it matters.",
  "Answer directly and briefly. Use plain text with light Markdown only: short headings, bullet lists, **bold**.",
  "Never use LaTeX. Write maths with ordinary characters and Unicode (x², √, ÷, ≤, π).",
  "If the handwriting is unreadable or the image is blank, say so plainly instead of guessing.",
].join(" ");

const OWN_DEFAULTS = {
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-5-mini" },
  anthropic: { baseURL: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" },
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

  // Long threads are trimmed, but the first message carries the page image and must always survive.
  let messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length > 24) {
    let tail = messages.slice(-23);
    if (tail[0]?.role === "user") tail = tail.slice(1);
    messages = [messages[0], ...tail];
  }
  if (!messages.length) return fail(400, "Nothing to ask yet.");
  let bytes = 0;
  for (const m of messages) {
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") return fail(400, "Malformed message.");
    if (m.image !== undefined && (typeof m.image !== "string" || !m.image.startsWith("data:image/"))) return fail(400, "Malformed image.");
    bytes += m.text.length + (m.image?.length ?? 0);
  }
  if (bytes > 3_600_000) return fail(413, "That page is too large to send. Try lassoing a smaller part.");

  // The person's own key, exactly as before. Whether it is used is the choice they made at
  // Sign in with publik: resolveProvider() picks this browser's publik key when they chose their
  // publik plan, else this key.
  let ownKey: { baseURL: string; apiKey: string } | null = null;
  let ownModel = "";
  let ownProblem: string | null = null;
  const own = body.own;
  if (own?.key) {
    if (own.kind === "custom") {
      if (process.env.LOOSELEAF_ALLOW_CUSTOM_BASE !== "1" || !own.baseURL) ownProblem = "Custom endpoints are turned off on this server.";
      else {
        ownKey = { baseURL: own.baseURL.replace(/\/+$/, ""), apiKey: own.key };
        ownModel = own.model || "default";
      }
    } else if (own.kind === "openai" || own.kind === "anthropic") {
      ownKey = { baseURL: OWN_DEFAULTS[own.kind].baseURL, apiKey: own.key };
      ownModel = own.model?.trim() || OWN_DEFAULTS[own.kind].model;
    } else {
      ownProblem = "Unknown key type.";
    }
  }

  const provider = resolveProvider(await cookies(), ownKey);
  if (provider.kind === "needs_own_key") {
    if (ownProblem) return fail(400, ownProblem);
    return fail(401, "Add your OpenAI or Anthropic API key, or switch to your publik plan.", { code: "needs_key" });
  }
  const viaPublik = provider.kind === "publik";
  const url = `${provider.baseURL}/chat/completions`;
  const apiKey = provider.apiKey;
  const model = viaPublik ? MODELS.balanced : ownModel;

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
    let parsed: { error?: { message?: string } } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    // publik's 402: its message plus exactly one link, error.top_up_url.
    const topUp = viaPublik && upstream.status === 402 ? topUpUrlFrom402(parsed) : null;
    let message = topUp?.message ?? parsed?.error?.message ?? "";
    if (!message) {
      message =
        upstream.status === 401 ? (viaPublik ? "publik did not accept this browser's key. Reload Looseleaf to sign in with publik again." : "Your provider rejected that API key.")
        : upstream.status === 429 ? "Rate limited. Give it a few seconds and try again."
        : `The AI provider answered ${upstream.status}.`;
    }
    return Response.json(
      { error: { message, top_up_url: topUp?.url ?? undefined, code: upstream.status === 402 && viaPublik ? "balance" : undefined } },
      { status: upstream.status === 200 ? 502 : upstream.status, headers: passthrough },
    );
  }

  passthrough.set("content-type", upstream.headers.get("content-type") ?? "text/event-stream");
  return new Response(upstream.body, { status: 200, headers: passthrough });
}
