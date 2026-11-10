"use client";

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eraser,
  FileDown,
  FileText,
  Hand,
  Highlighter,
  Image as ImageIcon,
  Lasso,
  Maximize,
  MoreHorizontal,
  PenLine,
  Plus,
  Redo2,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AIPanel, { type AIAction, type AIPanelHandle } from "./AIPanel";
import { InkEngine, type EngineState, type TextEdit } from "@/lib/engine";
import { SAVE_MESSAGES, exportLeaf, exportPDF, exportPNG, type SaveResult } from "@/lib/leaf";
import { TEXT_FONT, TEXT_LINE, pageToCanvas } from "@/lib/render";
import { getNotebook, saveNotebook } from "@/lib/store";
import { HIGHLIGHT_COLORS, HIGHLIGHT_SIZES, PEN_COLORS, PEN_SIZES, type Notebook, type Page, type Paper, type Tool } from "@/lib/types";

const TOOLS: { tool: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { tool: "pen", label: "Pen", key: "P", icon: <PenLine size={20} /> },
  { tool: "highlighter", label: "Highlighter", key: "H", icon: <Highlighter size={20} /> },
  { tool: "eraser", label: "Eraser", key: "E", icon: <Eraser size={20} /> },
  { tool: "lasso", label: "Lasso", key: "L", icon: <Lasso size={20} /> },
  { tool: "text", label: "Text", key: "T", icon: <Type size={20} /> },
];

const PAPERS: { paper: Paper; label: string }[] = [
  { paper: "ruled", label: "Ruled" },
  { paper: "grid", label: "Grid" },
  { paper: "dots", label: "Dots" },
  { paper: "blank", label: "Blank" },
];

const HINTS: Partial<Record<Tool, string>> = {
  eraser: "Swipe across ink to erase it",
  lasso: "Circle something to select it",
  text: "Tap the page to type",
};

export default function Editor({ id, onExit }: { id: string; onExit: () => void }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const engineRef = useRef<InkEngine | null>(null);
  const aiRef = useRef<AIPanelHandle>(null);
  const docRef = useRef<Notebook | null>(null);
  const editRef = useRef<TextEdit | null>(null);
  const dirty = useRef(false);
  const draft = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thumbPage = useRef<Page | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [es, setEs] = useState<EngineState | null>(null);
  const [title, setTitle] = useState("");
  const [pen, setPen] = useState({ color: PEN_COLORS[0], size: PEN_SIZES[1] });
  const [marker, setMarker] = useState({ color: HIGHLIGHT_COLORS[0], size: HIGHLIGHT_SIZES[1] });
  const [edit, setEdit] = useState<{ item: TextEdit["item"]; rect: ReturnType<InkEngine["textRect"]> } | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [menu, setMenu] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const flush = useCallback(async (commitText = false): Promise<boolean> => {
    // When leaving, text still being typed is part of the notebook: commit it before saving.
    if (commitText && editRef.current) engineRef.current?.finishTextEdit(draft.current);
    const doc = docRef.current;
    if (!dirty.current || !doc) return true;
    dirty.current = false;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    let thumb: string | undefined;
    if (doc.pages[0] !== thumbPage.current) {
      thumbPage.current = doc.pages[0];
      thumb = pageToCanvas(doc.pages[0], 0.3).toDataURL("image/jpeg", 0.72);
    }
    try {
      await saveNotebook(doc, thumb);
      if (!dirty.current) setSaveState("saved");
      return true;
    } catch {
      dirty.current = true;
      setSaveState("error");
      return false;
    }
  }, []);

  // Load the notebook, then hand the canvases to the engine.
  useEffect(() => {
    let cancelled = false;
    let engine: InkEngine | null = null;
    getNotebook(id)
      .then((doc) => {
        if (cancelled) return;
        if (!doc) return setStatus("missing");
        docRef.current = doc;
        thumbPage.current = doc.pages[0];
        setTitle(doc.title);
        engine = new InkEngine(baseRef.current!, overlayRef.current!, doc, {
          onState: setEs,
          onToast: setToast,
          onChange: (next) => {
            docRef.current = next;
            dirty.current = true;
            setSaveState("saving");
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => void flush(), 450);
          },
          onTextEdit: (next) => {
            const area = textRef.current;
            // Focus synchronously, inside the tap that asked for it, or iPadOS will not raise the keyboard.
            if (next && area && editRef.current?.item.id !== next.item.id) {
              area.value = next.item.text;
              draft.current = next.item.text;
              area.focus();
            }
            editRef.current = next;
            setEdit(next && engineRef.current ? { item: next.item, rect: engineRef.current.textRect(next) } : null);
          },
        });
        engineRef.current = engine;
        setEs(engine.state());
        setStatus("ready");
      })
      .catch(() => !cancelled && setStatus("error"));

    const onHide = () => {
      if (document.visibilityState === "hidden") flush(true);
    };
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => engineRef.current?.readTheme();
    document.addEventListener("visibilitychange", onHide);
    const onPageHide = () => void flush(true);
    window.addEventListener("pagehide", onPageHide);
    scheme.addEventListener("change", onScheme);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      scheme.removeEventListener("change", onScheme);
      flush(true);
      engine?.destroy();
      engineRef.current = null;
    };
  }, [id, flush]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const setTool = useCallback((tool: Tool) => engineRef.current?.setTool(tool), []);

  const choosePen = (next: Partial<typeof pen>) => {
    const value = { ...pen, ...next };
    setPen(value);
    if (engineRef.current) engineRef.current.styles.pen = value;
  };
  const chooseMarker = (next: Partial<typeof marker>) => {
    const value = { ...marker, ...next };
    setMarker(value);
    if (engineRef.current) engineRef.current.styles.highlighter = value;
  };

  const askAI = useCallback((action: AIAction | null, source: "page" | "selection") => {
    setAiOpen(true);
    setMenu(false);
    if (action) aiRef.current?.start(action, source);
  }, []);

  // Keyboard: single letters pick tools, the usual chords undo and redo.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      const target = e.target as HTMLElement;
      if (!engine || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        engine.redo();
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        engine.duplicateSelection();
      } else if (e.key === " ") {
        e.preventDefault();
        engine.spaceDown = true;
      } else if (e.key === "Backspace" || e.key === "Delete") {
        engine.deleteSelection();
      } else if (e.key === "Escape") {
        engine.clearSelection();
        setMenu(false);
      } else if (!mod && !e.altKey) {
        const hit = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
        if (hit) engine.setTool(hit.tool);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " " && engineRef.current) engineRef.current.spaceDown = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const runExport = async (label: string, job: (doc: Notebook) => Promise<SaveResult>) => {
    const doc = docRef.current;
    if (!doc) return;
    setMenu(false);
    setBusy(label);
    try {
      const message = SAVE_MESSAGES[await job(doc)];
      if (message) setToast(message);
    } catch {
      setToast("That export didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const exit = async () => {
    const saved = await flush(true);
    if (!saved && !window.confirm("Your latest changes couldn't be saved in this browser (storage may be full). Leave anyway?")) return;
    onExit();
  };

  const tool = es?.tool ?? "pen";
  const style = tool === "highlighter" ? marker : pen;
  const colors = tool === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS;
  const sizes = tool === "highlighter" ? HIGHLIGHT_SIZES : PEN_SIZES;
  const choose = tool === "highlighter" ? chooseMarker : choosePen;
  const rect = edit?.rect ?? null;
  const pill = "pointer-events-auto flex items-center rounded-full border border-line bg-panel/95 shadow-float backdrop-blur";
  const iconBtn = "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink hover:bg-panel-2 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="chrome fixed inset-0 overflow-hidden bg-desk">
      <canvas ref={baseRef} className="absolute inset-0 h-full w-full" />
      <canvas
        ref={overlayRef}
        className="ink-surface absolute inset-0 h-full w-full"
        style={{ cursor: tool === "text" ? "text" : tool === "lasso" ? "default" : "crosshair" }}
      />

      {/* Always mounted so it can be focused inside the tap that opens it (an iPadOS keyboard rule). */}
      <textarea
        ref={textRef}
        aria-label="Text on page"
        spellCheck={false}
        onBlur={(e) => {
          if (editRef.current) engineRef.current?.finishTextEdit(e.target.value);
        }}
        onInput={(e) => {
          const area = e.currentTarget;
          draft.current = area.value;
          area.style.height = "auto";
          area.style.height = `${area.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        className="absolute resize-none overflow-hidden rounded-sm bg-transparent p-0 outline-dashed outline-1 outline-offset-4 outline-accent"
        style={
          rect && edit
            ? {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                minHeight: rect.minHeight,
                fontSize: rect.fontSize,
                lineHeight: TEXT_LINE,
                fontFamily: TEXT_FONT,
                color: edit.item.color,
                userSelect: "text",
                WebkitUserSelect: "text",
              }
            : { left: -9999, top: 0, width: 10, height: 10, opacity: 0, pointerEvents: "none", fontSize: 16 }
        }
      />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className={`${pill} min-w-0 max-w-[46%] p-1 pr-3 sm:max-w-xs`}>
          <button onClick={exit} aria-label="Back to notebooks" className={iconBtn}>
            <ArrowLeft size={20} />
          </button>
          <input
            value={title}
            aria-label="Notebook title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              const clean = title.trim() || "Untitled notebook";
              setTitle(clean);
              if (clean !== docRef.current?.title) engineRef.current?.setTitle(clean);
            }}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="min-w-0 flex-1 truncate bg-transparent px-1 text-base font-semibold outline-none"
            style={{ userSelect: "text", WebkitUserSelect: "text" }}
          />
          <span
            title={saveState === "saved" ? "Saved in this browser" : saveState === "saving" ? "Saving" : "Couldn't save: storage is full or blocked"}
            className={`ml-1 flex h-5 shrink-0 items-center text-xs ${saveState === "error" ? "font-medium text-danger" : "text-muted"}`}
          >
            {saveState === "saved" ? <Check size={14} /> : saveState === "saving" ? <span className="caret">●</span> : "Not saved"}
          </span>
        </div>

        <div className="flex-1" />

        <div className={`${pill} p-1`}>
          <button onClick={() => engineRef.current?.undo()} disabled={!es?.canUndo} aria-label="Undo" className={iconBtn}>
            <Undo2 size={19} />
          </button>
          <button onClick={() => engineRef.current?.redo()} disabled={!es?.canRedo} aria-label="Redo" className={iconBtn}>
            <Redo2 size={19} />
          </button>
          <button
            onClick={() => (aiOpen ? setAiOpen(false) : askAI(null, "page"))}
            aria-pressed={aiOpen}
            className={`mx-0.5 flex h-10 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold ${aiOpen ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent"}`}
          >
            <Sparkles size={16} />
            <span className="hidden sm:inline">Ask AI</span>
          </button>
          <button onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu} className={iconBtn}>
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {menu && es && (
        <>
          <button aria-label="Close menu" className="absolute inset-0 z-10 cursor-default" onClick={() => setMenu(false)} />
          <div className="rise absolute right-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] z-20 w-64 overflow-hidden rounded-2xl border border-line bg-panel py-2 text-sm shadow-float">
            <p className="px-4 pb-1.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted">Paper for this page</p>
            <div className="grid grid-cols-4 gap-1.5 px-3 pb-2">
              {PAPERS.map((p) => (
                <button
                  key={p.paper}
                  onClick={() => engineRef.current?.setPaper(p.paper)}
                  className={`rounded-lg border px-1 py-1.5 text-xs font-medium ${es.paper === p.paper ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-panel-2"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <Divider />
            <Row icon={<Plus size={16} />} label="Add page after this one" onClick={() => { engineRef.current?.addPage(); setMenu(false); }} />
            <Row icon={<Trash2 size={16} />} label={es.pageCount > 1 ? "Delete this page" : "Clear this page"} onClick={() => { engineRef.current?.deletePage(); setMenu(false); }} />
            <Divider />
            <Row
              icon={<Hand size={16} />}
              label="Draw with finger"
              trailing={<Toggle on={es.fingerDraws} />}
              onClick={() => engineRef.current?.setFingerDraws(!es.fingerDraws)}
            />
            <Row icon={<Maximize size={16} />} label="Fit page to screen" onClick={() => { engineRef.current?.fit(); setMenu(false); }} />
            <Divider />
            <Row icon={<FileDown size={16} />} label="Save as .leaf file" onClick={() => runExport("Saving", exportLeaf)} />
            <Row icon={<FileText size={16} />} label="Export PDF" onClick={() => runExport("Making PDF", exportPDF)} />
            <Row icon={<ImageIcon size={16} />} label="Export this page as PNG" onClick={() => runExport("Rendering", (doc) => exportPNG(doc, es.pageIndex))} />
          </div>
        </>
      )}

      {/* Bottom: page navigator, selection actions, tools */}
      <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[padding] duration-200 ${aiOpen ? "md:pr-[396px]" : ""}`}>
        {es && es.selection > 0 && (
          <div className={`${pill} rise max-w-full gap-0.5 overflow-x-auto p-1 no-scrollbar`}>
            <span className="flex items-center gap-1.5 pl-3 pr-1 text-xs font-semibold text-accent">
              <Sparkles size={14} /> AI
            </span>
            <Chip label="To text" onClick={() => askAI("transcribe", "selection")} />
            <Chip label="Explain" onClick={() => askAI("explain", "selection")} />
            <Chip label="Solve" onClick={() => askAI("solve", "selection")} />
            <span className="mx-1 h-6 w-px shrink-0 bg-line" />
            <button onClick={() => engineRef.current?.duplicateSelection()} aria-label="Duplicate selection" className={iconBtn}>
              <Copy size={18} />
            </button>
            <button onClick={() => engineRef.current?.deleteSelection()} aria-label="Delete selection" className={`${iconBtn} text-danger`}>
              <Trash2 size={18} />
            </button>
          </div>
        )}

        <div className="flex w-full items-end justify-center gap-2">
          <div className={`${pill} max-w-full gap-0.5 overflow-x-auto p-1 no-scrollbar`}>
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                onClick={() => setTool(t.tool)}
                aria-label={`${t.label} (${t.key})`}
                aria-pressed={tool === t.tool}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors ${tool === t.tool ? "bg-ink text-desk" : "text-ink hover:bg-panel-2"}`}
              >
                {t.icon}
              </button>
            ))}
            <span className="mx-1.5 h-6 w-px shrink-0 bg-line" />
            {tool === "pen" || tool === "highlighter" ? (
              <>
                {colors.map((c) => (
                  <button
                    key={c}
                    onClick={() => choose({ color: c })}
                    aria-label={`Colour ${c}`}
                    aria-pressed={style.color === c}
                    className="flex h-9 w-8 shrink-0 items-center justify-center"
                  >
                    <span
                      className="block h-6 w-6 rounded-full transition-transform"
                      style={{
                        background: c,
                        boxShadow: style.color === c ? `0 0 0 2px var(--panel), 0 0 0 4px ${c}` : "inset 0 0 0 1px rgba(0,0,0,0.12)",
                        transform: style.color === c ? "scale(0.82)" : undefined,
                      }}
                    />
                  </button>
                ))}
                <span className="mx-1.5 h-6 w-px shrink-0 bg-line" />
                {sizes.map((s, i) => (
                  <button
                    key={s}
                    onClick={() => choose({ size: s })}
                    aria-label={`Thickness ${i + 1}`}
                    aria-pressed={style.size === s}
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.size === s ? "bg-panel-2 ring-1 ring-line" : ""}`}
                  >
                    <span className="block rounded-full bg-ink" style={{ width: 5 + i * 4, height: 5 + i * 4 }} />
                  </button>
                ))}
              </>
            ) : (
              <span className="whitespace-nowrap px-3 text-sm text-muted">{HINTS[tool]}</span>
            )}
          </div>
        </div>
      </div>

      {/* Page navigator */}
      {es && (
        <div className={`${pill} absolute left-3 top-[calc(max(0.75rem,env(safe-area-inset-top))+3.5rem)] gap-0.5 p-1 text-sm`}>
          <button onClick={() => engineRef.current?.scrollToPage(es.pageIndex - 1)} disabled={es.pageIndex === 0} aria-label="Previous page" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-panel-2 disabled:opacity-30">
            <ChevronUp size={16} />
          </button>
          <span className="min-w-[3.25rem] text-center font-medium tabular-nums">
            {es.pageIndex + 1} / {es.pageCount}
          </span>
          <button
            onClick={() => (es.pageIndex === es.pageCount - 1 ? engineRef.current?.addPage() : engineRef.current?.scrollToPage(es.pageIndex + 1))}
            aria-label={es.pageIndex === es.pageCount - 1 ? "Add page" : "Next page"}
            className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-panel-2"
          >
            {es.pageIndex === es.pageCount - 1 ? <Plus size={15} /> : <ChevronDown size={16} />}
          </button>
        </div>
      )}

      <AIPanel ref={aiRef} open={aiOpen} engine={engineRef} onClose={() => setAiOpen(false)} onToast={setToast} />

      {status !== "ready" && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-desk px-6 text-center">
          {status === "loading" ? (
            <p className="text-sm text-muted">Opening notebook…</p>
          ) : (
            <>
              <p className="font-serif text-2xl font-semibold">{status === "missing" ? "That notebook isn't in this browser." : "Couldn't open that notebook."}</p>
              <p className="max-w-sm text-sm leading-relaxed text-muted">
                {status === "missing"
                  ? "Notebooks live in the browser they were made in. To move one, export it as a .leaf file there and open it here."
                  : "This browser may be blocking local storage. Private browsing can do that."}
              </p>
              <button onClick={onExit} className="h-11 rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink">
                Back to notebooks
              </button>
            </>
          )}
        </div>
      )}

      {(toast || busy) && (
        <div role="status" className="rise pointer-events-none absolute left-1/2 top-[calc(max(0.75rem,env(safe-area-inset-top))+4rem)] z-40 -translate-x-1/2 whitespace-nowrap rounded-full bg-ink px-4 py-2 text-sm font-medium text-desk shadow-float">
          {busy ? `${busy}…` : toast}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div className="my-1.5 h-px bg-line" />;
}

function Row({ icon, label, onClick, trailing }: { icon: React.ReactNode; label: string; onClick: () => void; trailing?: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-panel-2">
      <span className="text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`flex h-6 w-10 items-center rounded-full p-0.5 transition-colors ${on ? "bg-accent" : "bg-line"}`}>
      <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
    </span>
  );
}

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="h-10 shrink-0 rounded-full px-3 text-sm font-medium hover:bg-panel-2">
      {label}
    </button>
  );
}
