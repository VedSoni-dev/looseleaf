"use client";

// PublikGate: Sign in with publik before the app's first screen, for a hosted Next.js app.
// Wrap the app in app/layout.tsx: <body><PublikGate appName="My App">{children}</PublikGate></body>.
// It draws what /api/publik/* answers; the words, the key and every publik call stay on the server
// (lib/publik.ts). Nothing of the app renders until the gate says "ready". Brand it with --publik-* CSS
// variables (see the README). usePublik() gives the app the choice; <PublikChoice /> is the setting.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Choice, GateAction, GateScreen, GateStatus } from "@/lib/publik"; // types only: no server code reaches the browser

type Shown = Extract<GateStatus, { screen: GateScreen }>;
type NoteKey = keyof Shown["notes"];
type Poll = { until: number; done: (s: GateStatus) => boolean; timeout: NoteKey };

export interface PublikState {
  /** true once the gate let the person in. */
  ready: boolean;
  /** "publik": AI goes through publik API; "own_key": the person's own key, exactly as before; null: the app uses no AI. */
  choice: Choice | null;
  usesAi: boolean;
  handle: string | null;
  /** setChoice() of the reference module. null shows the plan screen again. */
  setChoice: (choice: Choice | null) => Promise<void>;
}
const NOT_READY: PublikState = { ready: false, choice: null, usesAi: false, handle: null, setChoice: async () => {} };
const Ctx = createContext<PublikState>(NOT_READY);
export const usePublik = () => useContext(Ctx);

// Only when this app's own server does not answer. The words are gateScreen("unreachable") from lib/publik.ts.
const SERVER_DOWN = {
  screen: { id: "unreachable", title: "Sign in with publik", body: "publik is not reachable. Check your connection.", note: null, buttons: [{ action: "retry", label: "Retry" }] } as GateScreen,
  claimUrl: null,
  topUpUrl: null,
};

async function readStatus(res: Response): Promise<GateStatus> {
  const s = (await res.json()) as GateStatus;
  if (!s || typeof s.state !== "string") throw new Error("bad gate status");
  return s;
}
/** GET /api/publik/status; a browser with no install yet is provisioned once (POST /api/publik/provision). */
async function fetchStatus(): Promise<GateStatus> {
  const s = await readStatus(await fetch("/api/publik/status", { cache: "no-store" }));
  if (s.state !== "needs_install") return s;
  const p = await readStatus(await fetch("/api/publik/provision", { method: "POST", cache: "no-store" }));
  if (p.state === "needs_install") throw new Error("no install");
  return p;
}
let loading: Promise<GateStatus> | null = null; // one request at a time, so a browser never provisions twice
const loadStatus = () => (loading ??= fetchStatus().finally(() => { loading = null; }));
const signInPoll = (limitMs: number): Poll => ({ until: Date.now() + limitMs, done: (s) => s.state === "choose" || s.state === "ready", timeout: "signInTimeout" });
const planPoll = (limitMs: number): Poll => ({
  until: Date.now() + limitMs,
  done: (s) => s.state === "ready" || (s.state === "choose" && s.screen.buttons.some((b) => b.action === "connect")),
  timeout: "planTimeout",
});
async function postChoice(choice: Choice | null): Promise<void> {
  const res = await fetch("/api/publik/choice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choice }) });
  if (!res.ok) throw new Error(`choice ${res.status}`);
}
let openedThisPage = false; // app_opened once per page load (React runs effects twice in development)

export function PublikGate({ appName, children }: { appName?: string; children: ReactNode }) {
  const [status, setStatus] = useState<GateStatus | null>(null);
  const [down, setDown] = useState(false);
  const [busy, setBusy] = useState(true);
  const [note, setNote] = useState<NoteKey | null>(null);
  const [poll, setPoll] = useState<Poll | null>(null);
  const last = useRef<Shown | null>(null); // poll timing from the server (read in effects and handlers)
  const [notes, setNotes] = useState<Shown["notes"] | null>(null); // the server's notes, for rendering

  const accept = useCallback((s: GateStatus) => {
    if ("screen" in s) { last.current = s; setNotes(s.notes); }
    setDown(false);
    setStatus(s);
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true);
    try { accept(await loadStatus()); } catch { setDown(true); } finally { setBusy(false); }
  }, [accept]);
  useEffect(() => { queueMicrotask(() => void refresh()); }, [refresh]);

  const limitMs = () => last.current?.pollLimitMs ?? 600_000;

  // Like the reference gate: Sign in with publik checks every 3 s from the moment it shows, for at most 10 minutes.
  const state = down ? "down" : status?.state;
  useEffect(() => {
    queueMicrotask(() => {
      setNote(null);
      setPoll(state === "sign_in" ? signInPoll(last.current?.pollLimitMs ?? 600_000) : null);
    });
  }, [state]);

  useEffect(() => {
    if (!poll) return;
    let alive = true, inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const every = last.current?.pollMs ?? 3_000;
    const tick = async () => {
      if (!alive || inflight) return;
      if (Date.now() >= poll.until) { setNote(poll.timeout); setPoll(null); return; }
      inflight = true;
      const s = await loadStatus().catch(() => null);
      inflight = false;
      if (!alive) return;
      if (s && poll.done(s)) { setPoll(null); setNote(null); accept(s); return; }
      timer = setTimeout(tick, every);
    };
    const now = () => { clearTimeout(timer); void tick(); }; // back from the sign-in tab: check at once
    timer = setTimeout(tick, every);
    window.addEventListener("focus", now);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("focus", now); };
  }, [poll, accept]);

  // Opened the link some other way (middle click, "Open in new tab"), or came back after a timeout:
  // one check whenever this tab comes back into view.
  const title = status && "screen" in status ? status.screen.title : null;
  useEffect(() => {
    if (poll || (state !== "sign_in" && state !== "choose")) return;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void loadStatus().then((s) => {
        if (s.state === state && (!("screen" in s) || s.screen.title === title)) return;
        setNote(null);
        accept(s);
      }, () => {});
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [poll, state, title, accept]);

  async function act(a: GateAction) {
    if (a === "retry") return void refresh();
    if (a === "sign_in") {
      if (status?.state !== "sign_in" || !status.claimUrl) return void refresh();
      setNote("signInWaiting"); // the link itself opened claim_url in a new tab
      setPoll(signInPoll(limitMs()));
      return;
    }
    if (a === "get_plan") { setNote("planWaiting"); setPoll(planPoll(limitMs())); return; }
    setPoll(null);
    setNote(null);
    setBusy(true);
    try { await postChoice(a === "connect" ? "publik" : "own_key"); } catch { /* the next status shows the plan screen again */ }
    await refresh();
  }

  // Usage counting, after the gate: app_opened, then active_session every 30 minutes while the tab is open.
  const readySeconds = status?.state === "ready" && !down ? status.telemetrySeconds : 0;
  useEffect(() => {
    if (!readySeconds) return;
    const send = (event: "app_opened" | "active_session") =>
      fetch("/api/publik/telemetry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }), keepalive: true }).catch(() => {});
    if (!openedThisPage) { openedThisPage = true; void send("app_opened"); }
    const id = setInterval(() => void send("active_session"), readySeconds * 1000);
    return () => clearInterval(id);
  }, [readySeconds]);

  const setChoice = useCallback(async (c: Choice | null) => {
    await postChoice(c);
    if (c === null) return refresh();
    setStatus((s) => (s?.state === "ready" ? { ...s, choice: c } : s));
  }, [refresh]);
  const value = useMemo<PublikState>(
    () => (status?.state === "ready" ? { ready: true, choice: status.choice, usesAi: status.usesAi, handle: status.handle, setChoice } : { ...NOT_READY, setChoice }),
    [status, setChoice],
  );

  if (status?.state === "ready" && !down) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  const shown = down ? SERVER_DOWN : status && "screen" in status ? status : null;
  const noteText = note ? notes?.[note] ?? null : shown?.screen.note ?? null;
  return (
    <main className="pk-gate" aria-busy={busy || !shown}>
      <style href="publik-gate" precedence="default">{CSS}</style>
      <div className="pk-card" role="group" aria-labelledby="pk-title">
        {appName && <p className="pk-app">{appName}</p>}
        <h1 id="pk-title" className="pk-title">{shown?.screen.title ?? "Sign in with publik"}</h1>
        {shown ? (
          <p className="pk-body">{shown.screen.body}</p>
        ) : (
          <p className="pk-note"><span className="pk-spin" aria-hidden /></p>
        )}
        {noteText && (
          <p className="pk-note" role="status">
            {poll && (note === "signInWaiting" || note === "planWaiting") && <span className="pk-spin" aria-hidden />}
            {noteText}
          </p>
        )}
        {shown && (
          <div className="pk-buttons">
            {shown.screen.buttons.map((b, i) => {
              const cls = `pk-btn ${i === 0 ? "pk-primary" : "pk-secondary"}`;
              const href = b.action === "sign_in" ? shown.claimUrl : b.action === "get_plan" ? shown.topUpUrl : null;
              return href ? (
                <a key={b.action} href={href} target="_blank" rel="noopener noreferrer" className={cls}
                  onClick={() => void act(b.action)} onAuxClick={(e) => { if (e.button === 1) void act(b.action); }}>
                  {b.label}
                </a>
              ) : (
                <button key={b.action} type="button" className={cls} disabled={busy} onClick={() => void act(b.action)}>
                  {b.label}
                </button>
              );
            })}
          </div>
        )}
        <noscript><p className="pk-note">Turn on JavaScript to sign in with publik.</p></noscript>
      </div>
    </main>
  );
}

/** The setting that changes the stored choice (setChoice). Renders nothing when the app uses no AI. */
export function PublikChoice() {
  const { ready, usesAi, choice, handle, setChoice } = usePublik();
  const [busy, setBusy] = useState(false);
  if (!ready || !usesAi) return null;
  const pick = async (c: Choice | null) => {
    setBusy(true);
    try { await setChoice(c); } catch { /* unchanged */ } finally { setBusy(false); }
  };
  return (
    <div className="pk-choice" role="group" aria-label="How this app pays for AI">
      <style href="publik-gate" precedence="default">{CSS}</style>
      <div className="pk-choice-head">
        <span>Pay for AI with</span>
        {handle && <span className="pk-choice-who">publik: @{handle}</span>}
      </div>
      <div className="pk-seg">
        <button type="button" aria-pressed={choice === "publik"} disabled={busy} onClick={() => void pick("publik")}>publik plan</button>
        <button type="button" aria-pressed={choice === "own_key"} disabled={busy} onClick={() => void pick("own_key")}>My own key</button>
      </div>
      <p className="pk-choice-hint">
        {choice === "publik" ? "AI runs on publik API, paid from your publik plan." : "AI uses your own API key."}{" "}
        <button type="button" className="pk-link" disabled={busy} onClick={() => void pick(null)}>Ask me again</button>
      </p>
    </div>
  );
}

const CSS = `
.pk-gate,.pk-choice{--pk-bg:var(--publik-bg,#f6f5f1);--pk-card:var(--publik-card,#fff);--pk-ink:var(--publik-ink,#1c1b19);--pk-muted:var(--publik-muted,#6b6862);--pk-line:var(--publik-line,#e3e0d8);--pk-accent:var(--publik-accent,#1c1b19);--pk-accent-ink:var(--publik-accent-ink,#fff);--pk-hover:var(--publik-hover,rgba(0,0,0,.05))}
@media (prefers-color-scheme:dark){.pk-gate,.pk-choice{--pk-bg:var(--publik-bg,#121211);--pk-card:var(--publik-card,#1c1c1a);--pk-ink:var(--publik-ink,#f2f0ea);--pk-muted:var(--publik-muted,#a19d94);--pk-line:var(--publik-line,#33322e);--pk-accent:var(--publik-accent,#f2f0ea);--pk-accent-ink:var(--publik-accent-ink,#121211);--pk-hover:var(--publik-hover,rgba(255,255,255,.06))}}
.pk-gate{box-sizing:border-box;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--pk-bg);color:var(--pk-ink)}
.pk-card{box-sizing:border-box;width:100%;max-width:420px;padding:28px 24px;border:1px solid var(--pk-line);border-radius:20px;background:var(--pk-card);box-shadow:0 1px 0 rgba(0,0,0,.03),0 16px 40px -24px rgba(0,0,0,.35)}
.pk-app{margin:0 0 16px;font-size:13px;font-weight:600;letter-spacing:.01em;color:var(--pk-muted)}
.pk-title{margin:0 0 8px;font-family:var(--publik-display-font,inherit);font-size:26px;line-height:1.15;font-weight:700;letter-spacing:-.015em}
.pk-body{margin:0;font-size:15px;line-height:1.55}
.pk-note{display:flex;align-items:center;gap:8px;margin:14px 0 0;font-size:14px;line-height:1.45;color:var(--pk-muted)}
.pk-buttons{display:flex;flex-direction:column;gap:8px;margin-top:24px}
.pk-btn{box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-height:46px;padding:10px 16px;border:1px solid transparent;border-radius:12px;font:inherit;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;transition:opacity .15s,background-color .15s}
.pk-btn:disabled{opacity:.55;cursor:default}
.pk-btn:focus-visible,.pk-seg button:focus-visible,.pk-link:focus-visible{outline:2px solid var(--pk-accent);outline-offset:2px}
.pk-primary{background:var(--pk-accent);color:var(--pk-accent-ink)}
.pk-primary:hover{opacity:.9}
.pk-secondary{background:transparent;color:var(--pk-ink);border-color:var(--pk-line)}
.pk-secondary:hover{background:var(--pk-hover)}
.pk-spin{flex:none;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:pk-spin .8s linear infinite}
@keyframes pk-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.pk-spin{animation-duration:2.4s}}
.pk-choice{display:grid;gap:8px;color:var(--pk-ink)}
.pk-choice-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:14px;font-weight:500}
.pk-choice-who{font-size:12px;color:var(--pk-muted)}
.pk-seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border:1px solid var(--pk-line);border-radius:12px}
.pk-seg button{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--pk-ink);font:inherit;font-size:14px;font-weight:500;cursor:pointer}
.pk-seg button:hover{background:var(--pk-hover)}
.pk-seg button[aria-pressed=true]{background:var(--pk-accent);color:var(--pk-accent-ink)}
.pk-seg button:disabled,.pk-link:disabled{opacity:.6;cursor:default}
.pk-choice-hint{margin:0;font-size:12px;line-height:1.5;color:var(--pk-muted)}
.pk-link{padding:0;border:0;background:none;color:var(--pk-ink);font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
`;
