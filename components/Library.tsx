"use client";

import { Copy, FileDown, FileUp, FolderOpen, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openNotebook } from "./App";
import ImportProgress, { type ImportState } from "./ImportProgress";
import { prepareBackground } from "@/lib/backgrounds";
import { MAX_LEAF_BYTES, SAVE_MESSAGES, exportLeaf, importLeaf } from "@/lib/leaf";
import { isPdfFile, pdfTitle, pdfToPages } from "@/lib/pdf";
import { pageToCanvas } from "@/lib/render";
import { collectAssets, deleteAssets, deleteNotebook, formatBytes, getNotebook, listNotebooks, requestPersistence, saveNotebook, storageInfo } from "@/lib/store";
import { COVERS, newNotebook, uid, type Notebook, type NotebookMeta } from "@/lib/types";

const FIRST_RUN = "looseleaf.seen";

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const thumbOf = (nb: Notebook) => pageToCanvas(nb.pages[0], 0.3).toDataURL("image/jpeg", 0.72);
/** thumbOf, after decoding the first page's PDF background so it shows in the thumbnail. */
const thumbFor = async (nb: Notebook) => {
  await prepareBackground(nb.pages[0]);
  return thumbOf(nb);
};

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <rect x="15" y="10" width="34" height="44" rx="4" fill="#FFFDF8" />
      <path d="M22 37c5-11 9-11 11-3s6 6 10-7" fill="none" stroke="#1F1F1F" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Library() {
  const [books, setBooks] = useState<NotebookMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [storage, setStorage] = useState<{ used: number; persisted: boolean } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pdfInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<ImportState | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBooks(await listNotebooks());
      setStorage(await storageInfo());
    } catch {
      setError("This browser is blocking local storage (private browsing can do that), so notebooks can't be saved here.");
      setBooks([]);
    }
  }, []);

  const create = useCallback(async () => {
    try {
      const count = (await listNotebooks()).length;
      const nb = newNotebook("Untitled notebook", COVERS[count % COVERS.length]);
      await saveNotebook(nb, thumbOf(nb));
      requestPersistence();
      openNotebook(nb.id);
    } catch {
      setError("Couldn't create a notebook: this browser is blocking local storage.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // First ever visit: skip the empty shelf and put a pen in their hand.
      let firstRun = false;
      try {
        firstRun = !localStorage.getItem(FIRST_RUN);
      } catch {}
      if (firstRun) {
        const existing = await listNotebooks().catch(() => null);
        if (cancelled) return;
        try {
          localStorage.setItem(FIRST_RUN, "1");
        } catch {}
        if (existing && existing.length === 0) {
          await create();
          return;
        }
      }
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [create, refresh]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  // Abandon an import in progress if the library goes away (e.g. the person navigates back).
  useEffect(() => () => abort.current?.abort(), []);

  // Tidy up page images nothing uses any more (deleted PDF pages, an undone insert), once the shelf has settled.
  useEffect(() => {
    const t = setTimeout(() => void collectAssets().catch(() => {}), 4000);
    return () => clearTimeout(t);
  }, []);

  /** A PDF becomes a new notebook named after the file, one page per PDF page. */
  const importPdf = useCallback(async (file: File): Promise<string> => {
    const controller = new AbortController();
    abort.current = controller;
    setImporting({ name: file.name, done: 0, total: 0 });
    try {
      const { pages, thumb } = await pdfToPages(file, (p) => setImporting({ name: file.name, ...p }), controller.signal);
      const count = (await listNotebooks().catch(() => [])).length;
      const nb = newNotebook(pdfTitle(file.name), COVERS[count % COVERS.length]);
      nb.pages = pages;
      try {
        await saveNotebook(nb, thumb);
      } catch (e) {
        await deleteAssets(pages.map((p) => p.bg!.ref)).catch(() => {});
        throw e;
      }
      requestPersistence();
      return nb.id;
    } finally {
      abort.current = null;
      setImporting(null);
    }
  }, []);

  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      let opened = 0;
      let lastId = "";
      for (const file of Array.from(files)) {
        try {
          if (isPdfFile(file)) {
            lastId = await importPdf(file);
          } else {
            if (file.size > MAX_LEAF_BYTES) throw new Error(`This file is too large to open here (over ${MAX_LEAF_BYTES / 1024 / 1024} MB).`);
            const { notebook: nb, stored } = await importLeaf(await file.text());
            try {
              await saveNotebook(nb, await thumbFor(nb));
            } catch {
              await deleteAssets(stored).catch(() => {});
              throw new Error("Couldn't save it in this browser (storage may be full or blocked).");
            }
            lastId = nb.id;
          }
          opened++;
        } catch (e) {
          if ((e as Error)?.name === "AbortError") break;
          setError(`${file.name}: ${e instanceof Error ? e.message : "could not be opened."}`);
        }
      }
      if (opened === 1) openNotebook(lastId);
      else if (opened > 1) {
        setNotice(`Opened ${opened} notebooks.`);
        refresh();
      }
    },
    [importPdf, refresh],
  );

  const rename = async (id: string, title: string) => {
    setRenaming(null);
    const nb = await getNotebook(id);
    const clean = title.trim();
    if (!nb || !clean || clean === nb.title) return;
    await saveNotebook({ ...nb, title: clean, updatedAt: Date.now() });
    refresh();
  };

  const duplicate = async (id: string) => {
    const nb = await getNotebook(id);
    if (!nb) return;
    const copy = { ...nb, id: uid(), title: `${nb.title} copy`, createdAt: Date.now(), updatedAt: Date.now() };
    await saveNotebook(copy, await thumbFor(copy));
    refresh();
  };

  const exportOne = async (id: string) => {
    const nb = await getNotebook(id);
    if (!nb) return;
    try {
      const message = SAVE_MESSAGES[await exportLeaf(nb)];
      if (message) setNotice(message);
    } catch {
      setError("Couldn't save that file.");
    }
  };

  const remove = async (id: string) => {
    await deleteNotebook(id);
    setConfirming(null);
    setMenu(null);
    refresh();
  };

  const closeMenu = () => {
    setMenu(null);
    setConfirming(null);
  };

  return (
    <main
      className="chrome min-h-full bg-desk"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length && !abort.current) importFiles(e.dataTransfer.files);
      }}
    >
      {/* iOS greys out unknown extensions when `accept` is set, so the picker accepts anything and we validate. */}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) importFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {/* PDF is a type iOS knows, so this picker can filter to it (Files, iCloud Drive, Google Drive…). */}
      <input
        ref={pdfInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        data-testid="pdf-input"
        onChange={(e) => {
          if (e.target.files?.length) importFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="mx-auto max-w-6xl px-5 pb-24 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8">
        <header className="flex items-center gap-3 py-2">
          <Logo />
          <span className="font-serif text-xl font-semibold tracking-tight">Looseleaf</span>
          <div className="flex-1" />
          {/* On a phone-width screen these two are icon-only, so the header still fits in one row. */}
          <button
            onClick={() => pdfInput.current?.click()}
            aria-label="Import PDF"
            title="Import PDF"
            className="flex h-10 w-10 items-center justify-center gap-2 rounded-full border border-line bg-panel text-sm font-medium hover:bg-panel-2 sm:w-auto sm:px-4"
          >
            <FileUp size={16} />
            <span className="hidden sm:inline">Import PDF</span>
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            aria-label="Open .leaf"
            title="Open .leaf"
            className="flex h-10 w-10 items-center justify-center gap-2 rounded-full border border-line bg-panel text-sm font-medium hover:bg-panel-2 sm:w-auto sm:px-4"
          >
            <FolderOpen size={16} />
            <span className="hidden sm:inline">Open .leaf</span>
          </button>
          <button onClick={create} className="flex h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink hover:opacity-90">
            <Plus size={17} strokeWidth={2.5} />
            New<span className="hidden sm:inline"> notebook</span>
          </button>
        </header>

        <section className="mt-10 sm:mt-14">
          <h1 className="font-serif text-4xl font-semibold tracking-tight sm:text-5xl">Your notebooks</h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
            Everything here is saved in this browser, with no account. Import a PDF of lecture slides or a handout to write on it. Export a notebook as a{" "}
            <span className="font-medium text-ink">.leaf</span> file to open it on any other device.
          </p>
        </section>

        {error && (
          <div role="alert" className="mt-6 flex items-start gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-sm">
            <span className="flex-1 text-danger">{error}</span>
            <button onClick={() => setError(null)} className="font-medium text-muted hover:text-ink">
              Dismiss
            </button>
          </div>
        )}

        {books === null ? (
          <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="aspect-[816/1056] animate-pulse rounded-xl bg-panel/60" />
            ))}
          </div>
        ) : books.length === 0 ? (
          <div className="mt-12 rounded-3xl border border-dashed border-line px-6 py-16 text-center">
            <p className="font-serif text-2xl font-semibold">A clean desk.</p>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
              Start a notebook, import a PDF to annotate, or drop a .leaf file anywhere on this page to pick up where you left off.
            </p>
            <button onClick={create} className="mt-6 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90">
              <Plus size={17} strokeWidth={2.5} /> New notebook
            </button>
          </div>
        ) : (
          <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-5">
            {books.map((b) => (
              <li key={b.id} className="relative">
                <button
                  onClick={() => openNotebook(b.id)}
                  aria-label={`Open ${b.title}`}
                  className="group block w-full overflow-hidden rounded-r-xl rounded-l-[4px] bg-[#FFFDF8] shadow-float transition-transform duration-200 hover:-translate-y-1"
                  style={{ borderLeft: `10px solid ${b.cover}` }}
                >
                  <div className="aspect-[816/1056] w-full">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {b.thumb && <img src={b.thumb} alt="" draggable={false} className="h-full w-full object-cover" />}
                  </div>
                </button>
                <div className="mt-3 flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    {renaming === b.id ? (
                      <input
                        autoFocus
                        defaultValue={b.title}
                        onFocus={(e) => e.target.select()}
                        onBlur={(e) => rename(b.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="w-full rounded-md border border-line bg-panel px-1.5 py-0.5 text-sm font-medium outline-none focus:border-accent"
                        style={{ userSelect: "text", WebkitUserSelect: "text" }}
                      />
                    ) : (
                      <p className="truncate text-sm font-medium">{b.title}</p>
                    )}
                    <p className="mt-0.5 text-xs text-muted">
                      {b.pageCount} {b.pageCount === 1 ? "page" : "pages"} · {ago(b.updatedAt)}
                    </p>
                  </div>
                  <button
                    aria-label={`Options for ${b.title}`}
                    onClick={() => setMenu(menu === b.id ? null : b.id)}
                    className="-mr-1 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-panel hover:text-ink"
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </div>

                {menu === b.id && (
                  <>
                    <button aria-label="Close menu" className="fixed inset-0 z-10 cursor-default" onClick={closeMenu} />
                    <div className="rise absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-2xl border border-line bg-panel py-1.5 text-sm shadow-float">
                      <MenuRow icon={<Pencil size={15} />} label="Rename" onClick={() => { closeMenu(); setRenaming(b.id); }} />
                      <MenuRow icon={<Copy size={15} />} label="Duplicate" onClick={() => { closeMenu(); duplicate(b.id); }} />
                      <MenuRow icon={<FileDown size={15} />} label="Export .leaf" onClick={() => { closeMenu(); exportOne(b.id); }} />
                      <div className="my-1.5 h-px bg-line" />
                      {confirming === b.id ? (
                        <MenuRow icon={<Trash2 size={15} />} label="Tap again to delete" danger onClick={() => remove(b.id)} />
                      ) : (
                        <MenuRow icon={<Trash2 size={15} />} label="Delete" danger onClick={() => setConfirming(b.id)} />
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {books && books.length > 0 && storage && (
          <p className="mt-14 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            {storage.persisted && <ShieldCheck size={14} className="text-accent" />}
            <span>
              {books.length} {books.length === 1 ? "notebook" : "notebooks"} · {formatBytes(storage.used)} stored in this browser.
            </span>
            <span>
              {storage.persisted
                ? "Protected from automatic clearing."
                : "Browsers can clear site data when space runs low, so keep a .leaf copy of anything important."}
            </span>
          </p>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-3xl border-2 border-dashed border-accent bg-accent-soft/80">
          <p className="font-serif text-2xl font-semibold">Drop a PDF or .leaf to open</p>
        </div>
      )}

      {importing && <ImportProgress state={importing} onCancel={() => abort.current?.abort()} />}

      {notice && (
        <div role="status" className="rise fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-sm font-medium text-desk shadow-float">
          {notice}
        </div>
      )}
    </main>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-panel-2 ${danger ? "text-danger" : ""}`}>
      {icon}
      {label}
    </button>
  );
}
