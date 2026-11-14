"use client";

import { ArrowUp, Copy, KeyRound, Plus, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { AIError, DEFAULT_MODELS, loadOwnKey, plainText, saveOwnKey, streamChat, type ChatMsg, type OwnKey } from "@/lib/ai";
import type { InkEngine } from "@/lib/engine";
import { PublikChoice, usePublik } from "./PublikGate";

export type AIAction = "transcribe" | "explain" | "solve" | "summarize" | "flashcards" | "quiz";

export interface AIPanelHandle {
  start(action: AIAction, source: "page" | "selection"): void;
}

const ACTIONS: Record<AIAction, { label: string; prompt: string }> = {
  transcribe: {
    label: "Convert to text",
    prompt:
      "Transcribe this handwriting into clean typed text. Keep the original structure: headings, lists and line breaks. Fix obvious spelling slips. Output only the transcription, nothing before or after it.",
  },
  explain: { label: "Explain this", prompt: "Explain what is written here the way a patient tutor would, in a few short paragraphs." },
  solve: {
    label: "Solve this",
    prompt:
      "Solve the problem or problems written here. Show the key steps briefly, then give the final answer on its own line starting with 'Answer:'. If my own working is shown and has a mistake, point to the exact step.",
  },
  summarize: { label: "Summarize this page", prompt: "Summarize this page as a short bullet list of the key points." },
  flashcards: {
    label: "Make flashcards",
    prompt: "Turn this page into 5 to 10 flashcards. Write each as 'Q: …' on one line and 'A: …' on the next, with a blank line between cards.",
  },
  quiz: {
    label: "Quiz me",
    prompt: "Quiz me on this page. Ask 5 short numbered questions and do not give the answers. I will reply with mine and you will mark them.",
  },
};

const PAGE_ACTIONS: AIAction[] = ["summarize", "transcribe", "solve", "flashcards", "quiz"];

interface Failure {
  message: string;
  topUpUrl?: string;
  retry?: boolean;
  /** "My own key" was chosen at Sign in with publik and no key is saved yet. */
  needsKey?: boolean;
}

type View = "chat" | "key";

const NEEDS_KEY = "Add your OpenAI or Anthropic API key to use AI, or switch to your publik plan.";

const AIPanel = forwardRef<AIPanelHandle, { open: boolean; engine: RefObject<InkEngine | null>; onClose: () => void; onToast: (m: string) => void }>(
  function AIPanel({ open, engine, onClose, onToast }, ref) {
    const [msgs, setMsgs] = useState<ChatMsg[]>([]);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<Failure | null>(null);
    const [view, setView] = useState<View>("chat");
    const [own, setOwn] = useState<OwnKey | null>(null);
    const [balance, setBalance] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [form, setForm] = useState<OwnKey>({ kind: "openai", key: "", model: DEFAULT_MODELS.openai });

    const abort = useRef<AbortController | null>(null);
    const pending = useRef<ChatMsg[] | null>(null);
    const sending = useRef(false); // set before the first await, so a double tap cannot send twice
    const scroller = useRef<HTMLDivElement>(null);
    // The choice made at Sign in with publik (changed in AI settings): their publik plan, or their own key.
    const viaPublik = usePublik().choice === "publik";

    useEffect(() => {
      // Read once after mount: localStorage does not exist during server rendering.
      queueMicrotask(() => {
        const saved = loadOwnKey();
        setOwn(saved);
        if (saved) setForm(saved);
      });
      return () => abort.current?.abort();
    }, []);

    useEffect(() => {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    }, [msgs, failure, view]);

    const run = async (thread: ChatMsg[]) => {
      setFailure(null);
      setView("chat");
      setBusy(true);
      setMsgs([...thread, { role: "assistant", text: "" }]);
      const controller = new AbortController();
      abort.current = controller;
      let text = "";
      try {
        const result = await streamChat(
          thread,
          (delta) => {
            text += delta;
            setMsgs([...thread, { role: "assistant", text }]);
          },
          viaPublik,
          controller.signal,
        );
        if (result.balance) setBalance(result.balance);
        if (!text.trim()) {
          setMsgs(thread);
          setFailure({ message: "The AI sent back nothing. Try again.", retry: true });
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setMsgs(text ? [...thread, { role: "assistant", text }] : thread);
        } else if (e instanceof AIError && e.code === "needs_key") {
          setMsgs(thread);
          pending.current = thread;
          setFailure({ message: NEEDS_KEY, retry: true, needsKey: true });
          setView("key");
        } else {
          setMsgs(text ? [...thread, { role: "assistant", text }] : thread);
          const err = e instanceof AIError ? e : null;
          setFailure({
            message: err?.message ?? "Something went wrong. Try again.",
            topUpUrl: err?.topUpUrl,
            retry: err?.status !== 402 && err?.status !== 401,
          });
        }
      } finally {
        sending.current = false;
        setBusy(false);
      }
    };

    /** Sends the thread on the publik plan or the person's own key; with neither, parks it behind the key form. */
    const submit = (thread: ChatMsg[]) => {
      if (sending.current) return;
      sending.current = true;
      setFailure(null);
      setMsgs(thread);
      if (viaPublik || loadOwnKey()) return run(thread);
      pending.current = thread;
      sending.current = false;
      setFailure({ message: NEEDS_KEY, retry: true, needsKey: true });
      setView("key");
    };

    const preparing = useRef(false);
    const begin = async (text: string, label: string, source: "page" | "selection") => {
      const e = engine.current;
      if (!e || busy || sending.current || preparing.current) return;
      if (source === "page" && e.currentPageIsEmpty()) {
        setMsgs([]);
        setFailure({ message: "This page is blank. Write something first, then ask." });
        return;
      }
      // Async because a PDF page's image may need decoding first, so the AI sees the slide under the ink.
      // The guard stops a double tap from sending twice while that happens.
      preparing.current = true;
      let image: string | null;
      try {
        image = await (source === "selection" ? e.selectionImage() : e.pageImage());
      } catch {
        setFailure({ message: "Couldn't capture this page. Try again." });
        return;
      } finally {
        preparing.current = false;
      }
      if (!image) {
        setFailure({ message: "Nothing is selected. Circle some ink with the lasso first." });
        return;
      }
      submit([{ role: "user", text, label, image }]);
    };

    useImperativeHandle(ref, () => ({
      start(action, source) {
        void begin(ACTIONS[action].prompt, source === "selection" ? ACTIONS[action].label.replace(" page", "") : ACTIONS[action].label, source);
      },
    }));

    const send = () => {
      const text = draft.trim();
      if (!text || busy || sending.current) return;
      setDraft("");
      if (msgs.length === 0) void begin(text, text, "page");
      else submit([...msgs, { role: "user", text }]);
    };

    const saveKey = () => {
      const clean: OwnKey = { kind: form.kind, key: form.key.trim(), model: form.model.trim() || DEFAULT_MODELS[form.kind] };
      if (!clean.key) return;
      saveOwnKey(clean);
      setOwn(clean);
      setFailure(null);
      setView("chat");
      const thread = pending.current;
      pending.current = null;
      if (thread) run(thread);
    };

    const removeKey = () => {
      saveOwnKey(null);
      setOwn(null);
      setForm({ kind: "openai", key: "", model: DEFAULT_MODELS.openai });
      setView("chat");
    };

    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const field = "h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-base outline-none focus:border-accent";

    return (
      <aside
        aria-label="AI assistant"
        aria-hidden={!open}
        className={`${open ? "sheet-in flex" : "hidden"} absolute inset-x-0 bottom-0 z-20 h-[72dvh] flex-col overflow-hidden rounded-t-3xl border border-line bg-panel shadow-float md:inset-x-auto md:bottom-3 md:right-3 md:top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] md:h-auto md:w-[380px] md:rounded-3xl`}
      >
        <header className="flex items-center gap-2 border-b border-line py-2 pl-4 pr-2">
          <Sparkles size={17} className="text-accent" />
          <h2 className="flex-1 text-[15px] font-semibold">Ask AI</h2>
          {msgs.length > 0 && !busy && (
            <button
              onClick={() => {
                setMsgs([]);
                setFailure(null);
                setView("chat");
              }}
              className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-muted hover:bg-panel-2 hover:text-ink"
            >
              <Plus size={15} /> New
            </button>
          )}
          <button onClick={() => setView(view === "key" ? "chat" : "key")} aria-label="AI settings" aria-pressed={view === "key"} className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-ink">
            <KeyRound size={16} />
          </button>
          <button onClick={onClose} aria-label="Close AI panel" className="flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-panel-2 hover:text-ink">
            <X size={18} />
          </button>
        </header>

        <div ref={scroller} className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4" style={{ userSelect: "text", WebkitUserSelect: "text" }}>
          {view === "key" ? (
            <div className="space-y-5">
              {failure?.needsKey && (
                <p role="status" className="rounded-2xl border border-line bg-panel-2 p-4 text-sm leading-relaxed">
                  {failure.message}
                </p>
              )}
              <PublikChoice />
              <div className="space-y-3 border-t border-line pt-5">
                <h3 className="font-serif text-xl font-semibold">Use your own key</h3>
                <p className="text-sm leading-relaxed text-muted">
                  Paste an API key from OpenAI or Anthropic and AI calls are billed to you directly. A ChatGPT or Claude subscription is not an API key and won&apos;t work here.
                  {viaPublik && " A key saved here is used when you pick My own key above."}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {(["openai", "anthropic"] as const).map((kind) => (
                    <button
                      key={kind}
                      onClick={() => setForm({ ...form, kind, model: DEFAULT_MODELS[kind] })}
                      className={`h-11 rounded-xl border text-sm font-medium ${form.kind === kind ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-panel-2"}`}
                    >
                      {kind === "openai" ? "OpenAI" : "Anthropic"}
                    </button>
                  ))}
                </div>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={form.kind === "openai" ? "sk-…" : "sk-ant-…"}
                  aria-label="API key"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  className={field}
                />
                <input aria-label="Model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={field} />
                <p className="text-xs leading-relaxed text-muted">
                  The key stays in this browser. Each request passes it through Looseleaf&apos;s server straight to your provider; it is never stored or logged there.
                </p>
                <div className="flex gap-2 pt-1">
                  <button onClick={saveKey} disabled={!form.key.trim()} className="h-11 flex-1 rounded-full bg-accent text-sm font-semibold text-accent-ink disabled:opacity-40">
                    Save key
                  </button>
                  {own && (
                    <button onClick={removeKey} className="h-11 rounded-full border border-line px-4 text-sm font-medium text-danger hover:bg-panel-2">
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <>
              {msgs.length === 0 && view === "chat" && !failure && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-serif text-xl font-semibold">It can read your handwriting.</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">Ask about the page in view, or circle part of it with the lasso to ask about just that.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {PAGE_ACTIONS.map((a) => (
                      <button
                        key={a}
                        onClick={() => begin(ACTIONS[a].prompt, a === "transcribe" ? "Convert page to text" : a === "solve" ? "Solve this page" : ACTIONS[a].label, "page")}
                        className="h-10 rounded-full border border-line px-3.5 text-sm font-medium hover:bg-panel-2"
                      >
                        {a === "transcribe" ? "Convert page to text" : a === "solve" ? "Solve this page" : ACTIONS[a].label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {msgs.map((m, i) =>
                m.role === "user" ? (
                  <div key={i} className="ml-auto flex max-w-[88%] flex-col items-end gap-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.image && <img src={m.image} alt="What the AI was shown" className="max-h-36 rounded-xl border border-line bg-white object-contain" />}
                    <p className="rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 text-sm">{m.label ?? m.text}</p>
                  </div>
                ) : (
                  <div key={i} className="max-w-[96%]">
                    {m.text ? <Rich text={m.text} /> : <p className="caret text-sm text-muted">Reading your page…</p>}
                    {busy && i === msgs.length - 1 && m.text && <span className="caret text-accent">▍</span>}
                    {m.text && !(busy && i === msgs.length - 1) && (
                      <div className="mt-2.5 flex gap-2">
                        <button
                          onClick={() => {
                            engine.current?.insertText(plainText(m.text));
                            onToast("Added to the page. Drag it where you want it.");
                          }}
                          className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink"
                        >
                          <Plus size={15} strokeWidth={2.5} /> Add to page
                        </button>
                        <button
                          onClick={() => navigator.clipboard?.writeText(m.text).then(() => onToast("Copied."), () => onToast("Couldn't copy."))}
                          className="flex h-9 items-center gap-1.5 rounded-full border border-line px-3.5 text-sm font-medium hover:bg-panel-2"
                        >
                          <Copy size={14} /> Copy
                        </button>
                      </div>
                    )}
                  </div>
                ),
              )}

              {failure && (
                <div role="alert" className="rise space-y-2.5 rounded-2xl border border-line bg-panel-2 p-4 text-sm">
                  <p className="leading-relaxed">{failure.message}</p>
                  <div className="flex flex-wrap gap-2">
                    {failure.topUpUrl && (
                      <a href={failure.topUpUrl} target="_blank" rel="noopener noreferrer" className="flex h-9 items-center rounded-full bg-accent px-3.5 font-semibold text-accent-ink">
                        Top up on publik
                      </a>
                    )}
                    {failure.retry && lastUser && (
                      <button onClick={() => submit(last?.role === "assistant" ? msgs.slice(0, -1) : msgs)} className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-panel px-3.5 font-medium">
                        <RotateCcw size={14} /> Try again
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {view !== "key" && (
          <footer className="border-t border-line px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2.5">
            {(viaPublik || own) && (
              <p className="mb-2 truncate px-1 text-xs text-muted">
                {viaPublik
                  ? `publik plan${balance ? ` · balance ${balance}` : ""}`
                  : own && `Using your ${own.kind === "openai" ? "OpenAI" : "Anthropic"} key · ${own.model}`}
              </p>
            )}
            <div className="flex items-end gap-2">
              <textarea
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                placeholder={msgs.length ? "Ask a follow-up…" : "Ask about this page…"}
                aria-label="Message"
                className="max-h-28 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-panel-2 px-3.5 py-2.5 text-base outline-none focus:border-accent"
                style={{ userSelect: "text", WebkitUserSelect: "text" }}
              />
              {busy ? (
                <button onClick={() => abort.current?.abort()} aria-label="Stop" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink text-desk">
                  <Square size={15} fill="currentColor" />
                </button>
              ) : (
                <button onClick={send} disabled={!draft.trim()} aria-label="Send" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink disabled:opacity-35">
                  <ArrowUp size={19} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </footer>
        )}
      </aside>
    );
  },
);

export default AIPanel;

/** Just enough Markdown for model answers: headings, bullets, numbered lists, bold, inline code. */
function Rich({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{inline(item)}</li>);
    blocks.push(
      list.ordered ? (
        <ol key={blocks.length} className="list-decimal space-y-1 pl-5">{items}</ol>
      ) : (
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">{items}</ul>
      ),
    );
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    if (!line.trim()) continue; // a blank line inside a numbered list must not restart its numbering
    flush();
    if (heading) blocks.push(<p key={blocks.length} className="pt-1 font-semibold">{inline(heading[1])}</p>);
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="space-y-2 text-[15px] leading-relaxed">{blocks}</div>;
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-panel-2 px-1 py-0.5 text-[13px]">{part.slice(1, -1)}</code>;
    return part;
  });
}
