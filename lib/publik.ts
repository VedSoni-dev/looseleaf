// publik.ts — Sign in with publik, usage counting, and publik API as one provider option,
// for a Next.js app that is HOSTED for many browsers (Vercel, or `next start` on a server).
//
// Adapted from https://publikhq.com/sdk/publik.ts.md. The reference module keeps one credential
// file per computer. A hosted app serves many browsers, so here each browser gets its own install
// (POST /api/v1/installs) and its pk_ key rides in an AES-256-GCM sealed, http-only cookie that
// only this server can read. Nothing here reaches a browser bundle: never import this file from a
// "use client" component. The client half is components/PublikGate.tsx; the routes are app/api/publik/*.
//
// The gate (what ensureSignedIn() does in the reference module), per browser:
//   1. loads or provisions this browser's publik key (POST /api/v1/installs);
//   2. shows Sign in with publik until GET /api/v1/wallet says "claimed" (no other way past it);
//   3. when USES_AI: asks once how the app pays for AI and stores the answer (setChoice() changes it);
//   4. starts usage counting: app_opened once per browser session, then active_session every 30
//      minutes while the tab is open (POST /api/v1/telemetry, sent from this server).
// PUBLIK_SELF_TEST=1 at server start (instrumentation.ts) prints the self-test line and exits.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import type { cookies } from "next/headers";

export const APP_SLUG = "looseleaf";
export const APP_VERSION = "0.2.0";
/** false: the app calls no model. It still signs in and counts users; it skips the plan screen. */
export const USES_AI = true;
const ORIGIN = process.env.PUBLIK_ORIGIN || "https://publikhq.com"; // PUBLIK_ORIGIN: tests only
export const DEFAULT_BASE_URL = `${ORIGIN}/api/v1`;
/** Ask for a tier, never a vendor model name. */
export const MODELS = { fast: "publik-fast", balanced: "publik-balanced", smart: "publik-smart" } as const;
export type Tier = (typeof MODELS)[keyof typeof MODELS];
export const TIERS: readonly string[] = Object.values(MODELS);
const POLL_MS = 3_000, POLL_LIMIT_MS = 10 * 60_000; // the gate's poll, run by PublikGate.tsx
const YEAR = 60 * 60 * 24 * 365;

export type Choice = "publik" | "own_key";
export interface PublikCredential { key: string; install_id: string; claim_url: string | null }
export interface Wallet {
  claim_state: "anonymous" | "claimed"; claim_url: string | null; account: { handle: string | null } | null;
  plan: { kind: "none" | "plan" | "pack"; label: string | null }; balance_micros: number; top_up_url: string; linked_at: string | null;
}
export type GateAction = "sign_in" | "retry" | "get_plan" | "connect" | "own_key";
export interface GateScreen { id: "sign_in" | "unreachable" | "choose"; title: string; body: string; note: string | null; buttons: { action: GateAction; label: string }[] }
export type Provider = { kind: "own" | "publik"; baseURL: string; apiKey: string } | { kind: "needs_own_key" };
/** What the gate route answers; PublikGate.tsx draws it. */
export type GateStatus =
  | { state: "needs_install" }
  | { state: "unreachable" | "sign_in" | "choose"; screen: GateScreen; claimUrl: string | null; topUpUrl: string | null; notes: typeof GATE_NOTES; pollMs: number; pollLimitMs: number }
  | { state: "ready"; choice: Choice | null; usesAi: boolean; handle: string | null; telemetrySeconds: number };

/** Next's cookie store: `await cookies()` inside a route handler (where it can also set cookies). */
type Jar = Awaited<ReturnType<typeof cookies>>;
const COOKIE = { key: `${APP_SLUG}-publik`, choice: `${APP_SLUG}-publik-choice`, tid: `${APP_SLUG}-publik-tid`, seen: `${APP_SLUG}-publik-seen` };

// ---------- app token and the cookie seal ----------

/** The public `pat_` app token: PUBLIK_APP_TOKEN, else publik-app-token.txt at the repo root, else the
 *  same file's contents inlined at build time by next.config.ts (LOOSELEAF_APP_TOKEN). Never print it. */
function appToken(): string {
  const env = process.env.PUBLIK_APP_TOKEN?.trim();
  if (env) return env;
  try {
    const file = join(process.cwd(), "publik-app-token.txt");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch { /* fall through to the inlined copy */ }
  return process.env.LOOSELEAF_APP_TOKEN?.trim() ?? "";
}
export const available = () => appToken().startsWith("pat_");
const NO_TOKEN = "This build has no publik app token. Ask the developer for a new build.";

/** PUBLIK_COOKIE_SECRET, else a hash of the app token. Set the secret on any public deployment. */
const sealKey = () => createHash("sha256").update(`publik-cookie:${APP_SLUG}:${process.env.PUBLIK_COOKIE_SECRET || appToken()}`).digest();

function seal(c: PublikCredential): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ key: c.key, install_id: c.install_id, claim_url: c.claim_url }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}
function unseal(value: string | undefined): PublikCredential | null {
  if (!value || !available()) return null; // with no app token the seal key would be a public constant
  try {
    const raw = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", sealKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const c = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")) as PublikCredential;
    return typeof c.key === "string" && c.key.startsWith("pk_") ? c : null;
  } catch { return null; }
}

/** Development only (`next dev`): PUBLIK_API_KEY stands in for every browser's key. Ignored in production. */
function devKey(): string | null {
  return process.env.NODE_ENV === "development" && process.env.PUBLIK_API_KEY?.startsWith("pk_") ? process.env.PUBLIK_API_KEY : null;
}

const httpsOf = (req: Request) => (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim() === "https" || new URL(req.url).protocol === "https:";
const cookieOpts = (req: Request, maxAge?: number) => ({ httpOnly: true, sameSite: "lax" as const, secure: httpsOf(req), path: "/", ...(maxAge ? { maxAge } : {}) });

/** This browser's publik credential, from its sealed cookie. */
export function readCredential(jar: Jar): PublikCredential | null {
  const k = devKey();
  if (k) return { key: k, install_id: "", claim_url: null };
  return unseal(jar.get(COOKIE.key)?.value);
}
function writeCredential(jar: Jar, req: Request, c: PublikCredential | null): void {
  if (c) jar.set(COOKIE.key, seal(c), cookieOpts(req, YEAR)); // the key reaches the cookie before anything else sees it
  else jar.delete(COOKIE.key);
}
export function readChoice(jar: Jar): Choice | null {
  const v = jar.get(COOKIE.choice)?.value;
  return v === "publik" || v === "own_key" ? v : null;
}
/** The person's answer to the plan screen. Settings call it (via /api/publik/choice); null asks again. */
export function setChoice(jar: Jar, req: Request, choice: Choice | null): void {
  if (choice) jar.set(COOKIE.choice, choice, cookieOpts(req, YEAR));
  else jar.delete(COOKIE.choice);
}
/** Forget this browser's install (the next visit provisions a new one). */
export function forget(jar: Jar): void {
  for (const name of [COOKIE.key, COOKIE.choice, COOKIE.seen]) jar.delete(name);
}

/** The key this app uses for this browser: the stored choice decides. Call it where the app picks its AI client. */
export function resolveProvider(jar: Jar, userKey?: { baseURL: string; apiKey: string } | null): Provider {
  const k = devKey();
  if (k) return { kind: "publik", baseURL: process.env.PUBLIK_API_BASE_URL || DEFAULT_BASE_URL, apiKey: k };
  const c = readCredential(jar);
  if (c && readChoice(jar) === "publik") return { kind: "publik", baseURL: DEFAULT_BASE_URL, apiKey: c.key };
  return userKey?.apiKey ? { kind: "own", ...userKey } : { kind: "needs_own_key" };
}

// ---------- installs and the wallet ----------

/** os for publik, from a browser's user agent (the reference module uses the computer's platform). */
function osOf(ua: string): "macos" | "windows" | "linux" {
  return /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh|iPhone|iPad/i.test(ua) ? "macos" : "linux";
}
function deviceName(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Web browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return (os ? `${browser} on ${os}` : browser).slice(0, 120);
}
/** Crawlers that run JavaScript must not create installs. */
const isBot = (ua: string) => /(bot|crawler|spider)\/\d|facebookexternalhit|slurp/i.test(ua);
const offline = (e: unknown) => e instanceof TypeError || (e instanceof Error && /abort|timeout/i.test(e.name));

/** POST /api/v1/installs: one browser's (or the self-test's) publik key. Throws a readable message. */
export async function provision(opts: { os: string; deviceName: string }): Promise<PublikCredential> {
  const token = appToken();
  if (APP_SLUG.startsWith("__")) throw new Error("APP_SLUG is not set in lib/publik.ts.");
  if (!token.startsWith("pat_")) throw new Error(NO_TOKEN);
  let installId = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${ORIGIN}/api/v1/installs`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000), cache: "no-store",
      body: JSON.stringify({ app_token: token, app_slug: APP_SLUG, app_version: APP_VERSION, os: opts.os, device_name: opts.deviceName,
        install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] }),
    });
    const body = (await res.json().catch(() => ({}))) as { key?: unknown; install_id?: string; claim_url?: string | null; error?: { message?: string; type?: string } };
    if ((res.status === 201 || res.status === 200) && typeof body.key === "string" && body.key.startsWith("pk_")) {
      return { key: body.key, install_id: body.install_id ?? installId, claim_url: body.claim_url ?? null };
    }
    // A replay whose key this browser no longer holds, or a revoked install: one fresh install_id.
    if (res.status === 200 || body.error?.type === "install_revoked") { installId = randomUUID(); continue; }
    throw new Error(body.error?.message ?? `publik could not set up this browser (${res.status}).`);
  }
  throw new Error("publik could not set up this browser.");
}

/** GET /api/v1/wallet. 401: the key is gone (null wallet). Throws when publik is not reachable. */
export async function readWallet(key: string): Promise<{ status: number; wallet: Wallet | null; message: string | null }> {
  const res = await fetch(`${ORIGIN}/api/v1/wallet`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  const b = (await res.json().catch(() => ({}))) as Partial<Wallet> & { error?: { message?: string } };
  if (!res.ok || typeof b.claim_state !== "string") return { status: res.status, wallet: null, message: b.error?.message ?? null };
  return { status: res.status, message: null, wallet: { ...b, account: b.account ?? null, plan: b.plan ?? { kind: "none", label: null }, balance_micros: b.balance_micros ?? 0 } as Wallet };
}

// ---------- the gate ----------

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
/** The words of the gate. The same in every publik module. */
export function gateScreen(id: GateScreen["id"], w: Wallet | null, note: string | null = null, message?: string): GateScreen {
  if (id === "unreachable") return { id, title: "Sign in with publik", body: message ?? "publik is not reachable. Check your connection.", note, buttons: [{ action: "retry", label: "Retry" }] };
  if (id === "sign_in") return { id, title: "Sign in with publik", note, buttons: [{ action: "sign_in", label: "Sign in with publik" }],
    body: "This app uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in." };
  const who = w?.account?.handle ? `You are signed in as @${w.account.handle}.` : "You are signed in to publik.";
  if (!w || (w.plan.kind === "none" && w.balance_micros === 0)) return { id, title: "Choose how to pay for AI", note,
    body: `${who} This app uses AI. Get a publik plan, or use your own key.`, buttons: [{ action: "get_plan", label: "Get a plan" }, { action: "own_key", label: "Use my own key" }] };
  const what = w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : `Your balance: ${dollars(w.balance_micros)}.`;
  return { id, title: "Connect your plan", note, body: `${who} ${what} Connect it to use AI in this app, or use your own key.`,
    buttons: [{ action: "connect", label: "Connect your plan" }, { action: "own_key", label: "Use my own key" }] };
}
/** The notes the gate shows while it waits (the reference module's signNote / planNote). */
export const GATE_NOTES = {
  signInWaiting: "Waiting for you to sign in in your browser.",
  signInTimeout: "No sign-in after 10 minutes. Click Sign in with publik to try again.",
  planWaiting: "Waiting for your plan. Finish in your browser.",
  planTimeout: "No plan after 10 minutes. Click Get a plan to try again.",
} as const;

function show(state: "unreachable" | "sign_in" | "choose", screen: GateScreen, extra: { claimUrl?: string | null; topUpUrl?: string | null } = {}): GateStatus {
  return { state, screen, claimUrl: extra.claimUrl ?? null, topUpUrl: extra.topUpUrl ?? null, notes: GATE_NOTES, pollMs: POLL_MS, pollLimitMs: POLL_LIMIT_MS };
}
const unreachable = (e: unknown) => show("unreachable", gateScreen("unreachable", null, null, offline(e) ? undefined : e instanceof Error ? e.message : String(e)));

async function screenFor(jar: Jar, c: PublikCredential): Promise<GateStatus | "revoked"> {
  let r: Awaited<ReturnType<typeof readWallet>>;
  try { r = await readWallet(c.key); } catch (e) { return unreachable(e); }
  if (r.status === 401 && !devKey()) return "revoked"; // a revoked key: provision again
  const w = r.wallet;
  if (!w) return show("unreachable", gateScreen("unreachable", null, null, r.message ?? undefined));
  if (w.claim_state !== "claimed") return show("sign_in", gateScreen("sign_in", w), { claimUrl: w.claim_url ?? c.claim_url ?? `${ORIGIN}/wallet` });
  const choice = USES_AI ? readChoice(jar) : null;
  if (USES_AI && !choice) return show("choose", gateScreen("choose", w), { topUpUrl: w.top_up_url });
  const s = Number(process.env.PUBLIK_TELEMETRY_INTERVAL_SECONDS); // tests only
  return { state: "ready", choice, usesAi: USES_AI, handle: w.account?.handle ?? null, telemetrySeconds: s >= 1 && s <= 86_400 ? s : 1_800 };
}

/** One step of the gate for this browser. GET /api/publik/status passes provision:false (read only);
 *  POST /api/publik/provision passes true and creates this browser's install when it has none. */
export async function gateStatus(jar: Jar, req: Request, opts: { provision: boolean }): Promise<GateStatus> {
  if (!available() && !devKey()) return show("unreachable", gateScreen("unreachable", null, null, NO_TOKEN));
  const ua = req.headers.get("user-agent") ?? "";
  const prior = readCredential(jar);
  if (prior) {
    const s = await screenFor(jar, prior);
    if (s !== "revoked") return s;
    writeCredential(jar, req, null);
  }
  if (isBot(ua)) return show("sign_in", gateScreen("sign_in", null));
  if (!opts.provision) return { state: "needs_install" };
  let c: PublikCredential;
  try { c = await provision({ os: osOf(ua), deviceName: deviceName(ua) }); } catch (e) { return unreachable(e); }
  writeCredential(jar, req, c);
  const s = await screenFor(jar, c);
  return s === "revoked" ? show("unreachable", gateScreen("unreachable", null, null, "publik did not accept this browser's new key. Try again later.")) : s;
}

// ---------- the self-test (instrumentation.ts runs it when the server starts) ----------

/** Builder check, run by the BUILT app: PUBLIK_SELF_TEST=1 npm run start prints this line and exits. */
export async function selfTest(): Promise<string> {
  try {
    const os = ({ darwin: "macos", win32: "windows" } as Record<string, string>)[platform()] ?? "linux";
    const r = await readWallet((await provision({ os, deviceName: "self-test" })).key);
    if (!r.wallet) throw new Error(r.message ?? `GET /wallet answered ${r.status}`);
    return `publik self-test: ok ${APP_SLUG} ${APP_VERSION}`;
  } catch (e) {
    return `publik self-test: failed: ${offline(e) ? "publik is not reachable. Check your connection." : e instanceof Error ? e.message : String(e)}`;
  }
}
export async function runSelfTest(): Promise<never> {
  // writeSync, not console.log: process.exit() right after a buffered console line can drop it.
  writeSync(1, `${await selfTest()}\n`);
  process.exit(0);
}

// ---------- usage counting: /skills/telemetry.md sections 3-5, one telemetry install_id per browser ----------

export type UsageEvent = "app_opened" | "active_session";
export const USAGE_EVENTS: readonly UsageEvent[] = ["app_opened", "active_session"];

/** Opt-outs: the browser's Do Not Track or Global Privacy Control, or the operator's DO_NOT_TRACK / PUBLIK_TELEMETRY=off. */
function usageOff(req: Request): boolean {
  if (req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1") return true;
  const dnt = (process.env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;
  return ["0", "false", "off"].includes((process.env.PUBLIK_TELEMETRY ?? "").trim().toLowerCase());
}
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** POST /api/publik/telemetry calls this. app_opened once per browser session (a session cookie remembers it),
 *  then active_session at most every ~30 minutes, whatever the number of open tabs. Never throws. */
export async function sendUsage(jar: Jar, req: Request, event: UsageEvent): Promise<{ sent: boolean; reason?: string; status?: number }> {
  const say = (result: unknown) => { if (process.env.PUBLIK_TELEMETRY_DEBUG === "1") process.stderr.write(`publik-telemetry: ${event} -> ${result}\n`); };
  try {
    if (!USAGE_EVENTS.includes(event)) return { sent: false, reason: "bad_event" };
    if (usageOff(req)) { say("off (opt-out)"); return { sent: false, reason: "opt_out" }; }
    const c = readCredential(jar);
    if (!c) return { sent: false, reason: "no_install" };
    const s = Number(process.env.PUBLIK_TELEMETRY_INTERVAL_SECONDS);
    const minGap = (s >= 1 && s <= 86_400 ? s : 1_800) * 800; // 80% of the interval: tabs and timers drift
    const last = Number(jar.get(COOKIE.seen)?.value) || 0;
    if (event === "app_opened" && last) return { sent: false, reason: "already_opened" };
    if (event === "active_session" && Date.now() - last < minGap) return { sent: false, reason: "too_soon" };
    let tid = (jar.get(COOKIE.tid)?.value ?? "").toLowerCase();
    if (!UUID4.test(tid)) { tid = randomUUID(); jar.set(COOKIE.tid, tid, cookieOpts(req, YEAR)); }
    const ua = req.headers.get("user-agent") ?? "";
    const body = { v: 1, app: APP_SLUG, install_id: tid, event, app_version: APP_VERSION.replace(/^v/i, ""), os: osOf(ua) };
    const res = await fetch(process.env.PUBLIK_TELEMETRY_URL || `${ORIGIN}/api/v1/telemetry`, { method: "POST", signal: AbortSignal.timeout(5_000), cache: "no-store",
      headers: { "content-type": "application/json", authorization: `Bearer ${c.key}` }, body: JSON.stringify(body) });
    jar.set(COOKIE.seen, String(Date.now()), cookieOpts(req)); // a session cookie: gone when the browser closes
    say(res.status);
    return { sent: res.ok, status: res.status };
  } catch (e) { say(e instanceof Error ? e.name : "error"); return { sent: false, reason: "error" }; }
}

// ---------- publik API calls ----------

/** OpenAI-compatible client config: new OpenAI(clientConfig(p)). */
export function clientConfig(p: Extract<Provider, { apiKey: string }>) { return { baseURL: p.baseURL, apiKey: p.apiKey }; }

/** A 402 renders its message plus exactly ONE link: this one. */
export function topUpUrlFrom402(body: unknown): { message: string; url: string | null } {
  const e = (body as { error?: { message?: string; top_up_url?: string } } | null)?.error;
  return { message: e?.message ?? "Not enough publik API balance.", url: e?.top_up_url ?? null };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { ok: true; text: string } | { ok: false; status: number; message: string; topUpUrl: string | null };

/** One non-streaming POST /chat/completions on publik API with a tier model. On 402: its message and its one link. */
export async function publikChat(
  p: Extract<Provider, { apiKey: string }>,
  req: { model?: string; messages: ChatMessage[]; max_tokens?: number; temperature?: number },
  signal?: AbortSignal,
): Promise<ChatResult> {
  const model = TIERS.includes(req.model ?? "") ? req.model : MODELS.balanced;
  let res: Response;
  try {
    const timeout = AbortSignal.timeout(120_000);
    res = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST", cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ ...req, model, stream: false }),
    });
  } catch {
    return { ok: false, status: 502, message: "publik API is not reachable right now. Try again, or use your own key.", topUpUrl: null };
  }
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: unknown } }[]; error?: { message?: string } };
  if (res.status === 402) { const t = topUpUrlFrom402(body); return { ok: false, status: 402, message: t.message, topUpUrl: t.url }; }
  if (!res.ok) return { ok: false, status: res.status >= 500 ? 502 : res.status, message: body.error?.message ?? `publik API answered ${res.status}.`, topUpUrl: null };
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
  return { ok: true, text };
}
