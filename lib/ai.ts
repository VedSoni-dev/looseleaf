// Browser side of the AI features. Keys never live here except the user's own, which stays in this browser.

export interface OwnKey {
  kind: "openai" | "anthropic";
  key: string;
  model: string;
}

export interface ChatMsg {
  role: "user" | "assistant";
  text: string;
  /** JPEG data URL of the page or lassoed region. */
  image?: string;
  /** Short label shown in the thread instead of the full prompt. */
  label?: string;
}

export interface PublikCard {
  balance_line: string;
  cost_sentence: string | null;
  claim_state: "anonymous" | "claimed";
  claim_url: string | null;
  add_credit_url: string | null;
}

export class AIError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public topUpUrl?: string,
  ) {
    super(message);
  }
}

const OWN_KEY = "looseleaf.ownkey";
const PUBLIK_CARD = "looseleaf.publik";

function read<T>(name: string): T | null {
  try {
    const raw = localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(name: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(name);
    else localStorage.setItem(name, JSON.stringify(value));
  } catch {}
}

export const loadOwnKey = () => read<OwnKey>(OWN_KEY);
export const saveOwnKey = (k: OwnKey | null) => write(OWN_KEY, k);
export const loadPublikCard = () => read<PublikCard>(PUBLIK_CARD);
export const savePublikCard = (c: PublikCard | null) => write(PUBLIK_CARD, c);

export const DEFAULT_MODELS: Record<OwnKey["kind"], string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5-5",
};

export async function publikStatus(): Promise<{ connected: boolean; available: boolean; disclosure: string }> {
  const res = await fetch("/api/publik/status", { cache: "no-store" });
  if (!res.ok) throw new AIError("Could not check AI status.", res.status);
  return res.json();
}

/** Only call after the user pressed the button under the disclosure text. */
export async function turnOnPublik(): Promise<PublikCard> {
  const res = await fetch("/api/publik/provision", { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AIError(body?.error?.message ?? "publik API could not be set up. Use your own key for now.", res.status);
  savePublikCard(body);
  return body;
}

export interface StreamResult {
  provider: string | null;
  /** Raw x-publik-balance header, when publik served the call. */
  balance: string | null;
}

export async function streamChat(messages: ChatMsg[], onDelta: (text: string) => void, signal?: AbortSignal): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        own: loadOwnKey(),
        messages: messages.map(({ role, text, image }) => ({ role, text, image })),
      }),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new AIError(navigator.onLine ? "Could not reach the server. Try again." : "You're offline. Your notes still save; AI needs a connection.", 0, "offline");
  }

  const result: StreamResult = {
    provider: res.headers.get("x-looseleaf-provider"),
    balance: res.headers.get("x-publik-balance"),
  };

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AIError(body?.error?.message ?? `The AI answered ${res.status}.`, res.status, body?.error?.code, body?.error?.top_up_url);
  }

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("event-stream") || !res.body) {
    const body = await res.json().catch(() => ({}));
    onDelta(body?.choices?.[0]?.message?.content ?? "");
    return result;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        if (json?.error?.message) throw new AIError(json.error.message, 502);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) onDelta(delta);
      } catch (e) {
        if (e instanceof AIError) throw e;
      }
    }
  }
  return result;
}

/** For "Add to page": typed text reads better without Markdown markers. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}
