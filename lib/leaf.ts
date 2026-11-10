// .leaf files: a whole notebook as plain JSON, so it opens anywhere Looseleaf runs.
import { pageToCanvas } from "./render";
import { COVERS, PAGE_H, PAGE_W, uid, type Item, type Notebook, type Page, type Paper } from "./types";

const COLOR = /^#[0-9a-f]{3,8}$/i;
const PAPERS: Paper[] = ["blank", "ruled", "grid", "dots"];

const num = (v: unknown, fallback: number, min = -1e6, max = 1e6) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const str = (v: unknown, fallback: string, max = 20000) => (typeof v === "string" ? v.slice(0, max) : fallback);

function cleanItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const color = typeof r.color === "string" && COLOR.test(r.color) ? r.color : "#1F1F1F";
  if (r.type === "stroke") {
    if (!Array.isArray(r.pts) || r.pts.length < 3) return null;
    const pts: number[] = [];
    for (let i = 0; i + 2 < r.pts.length; i += 3) {
      pts.push(num(r.pts[i], 0), num(r.pts[i + 1], 0), num(r.pts[i + 2], 0.5, 0, 1));
    }
    const item: Item = {
      id: str(r.id, uid(), 64),
      type: "stroke",
      tool: r.tool === "highlighter" ? "highlighter" : "pen",
      color,
      size: num(r.size, 4, 0.5, 80),
      pts,
    };
    if (r.real === true) item.real = true;
    return item;
  }
  if (r.type === "text") {
    return {
      id: str(r.id, uid(), 64),
      type: "text",
      x: num(r.x, 80),
      y: num(r.y, 80),
      w: num(r.w, 400, 40, PAGE_W),
      text: str(r.text, ""),
      color,
      size: num(r.size, 18, 8, 96),
    };
  }
  return null; // item types from a newer version are skipped rather than crashing
}

/** Reads untrusted file text into a notebook. Throws an Error with a message fit to show the user. */
export function parseLeaf(text: string): Notebook {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a Looseleaf notebook (it isn't valid JSON).");
  }
  if (!raw || raw.format !== "looseleaf" || !Array.isArray(raw.pages)) {
    throw new Error("That file isn't a Looseleaf notebook.");
  }
  if (typeof raw.version === "number" && raw.version > 1) {
    throw new Error("This notebook was saved by a newer Looseleaf. Reload the app to update, then try again.");
  }
  const pages: Page[] = (raw.pages as unknown[]).slice(0, 2000).map((p) => {
    const page = (p ?? {}) as Record<string, unknown>;
    const items = Array.isArray(page.items) ? page.items.map(cleanItem).filter((i): i is Item => !!i) : [];
    return {
      id: uid(), // page ids are internal; fresh ones rule out duplicates in a hand-edited file
      paper: PAPERS.includes(page.paper as Paper) ? (page.paper as Paper) : "ruled",
      items,
    };
  });
  const now = Date.now();
  return {
    format: "looseleaf",
    version: 1,
    id: uid(), // always a fresh id: importing never overwrites a notebook already in this browser
    title: str(raw.title, "Imported notebook", 200) || "Imported notebook",
    cover: typeof raw.cover === "string" && COLOR.test(raw.cover) ? raw.cover : COVERS[0],
    createdAt: num(raw.createdAt, now, 0, 1e14),
    updatedAt: now,
    pages: pages.length ? pages : [{ id: uid(), paper: "ruled", items: [] }],
  };
}

function safeName(title: string): string {
  return (title.trim() || "notebook").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").slice(0, 80);
}

export type SaveResult = "saved" | "shared" | "downloaded" | "cancelled";

/** Best available "save a file" for this device: a real save dialog, the iPad share sheet, or a download. */
export async function saveFile(blob: Blob, name: string, description: string): Promise<SaveResult> {
  const ext = name.slice(name.lastIndexOf("."));
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description, accept: { [blob.type || "application/octet-stream"]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
      // fall through to a plain download
    }
  }
  const touch = window.matchMedia("(pointer: coarse)").matches;
  if (touch && navigator.canShare) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (e) {
        if ((e as Error).name === "AbortError") return "cancelled";
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}

export function exportLeaf(nb: Notebook): Promise<SaveResult> {
  const blob = new Blob([JSON.stringify(nb)], { type: "application/json" });
  return saveFile(blob, `${safeName(nb.title)}.leaf`, "Looseleaf notebook");
}

export async function exportPNG(nb: Notebook, pageIndex: number): Promise<SaveResult> {
  const canvas = pageToCanvas(nb.pages[pageIndex], 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render that page.");
  return saveFile(blob, `${safeName(nb.title)} p${pageIndex + 1}.png`, "PNG image");
}

export async function exportPDF(nb: Notebook): Promise<SaveResult> {
  const { jsPDF } = await import("jspdf");
  const w = PAGE_W * 0.75;
  const h = PAGE_H * 0.75;
  const pdf = new jsPDF({ unit: "pt", format: [w, h], compress: true });
  for (let i = 0; i < nb.pages.length; i++) {
    if (i > 0) pdf.addPage([w, h]);
    const canvas = pageToCanvas(nb.pages[i], 2);
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, w, h);
    canvas.width = 0; // hand the bitmap back now: iPad Safari has a small canvas memory budget
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return saveFile(pdf.output("blob"), `${safeName(nb.title)}.pdf`, "PDF document");
}

export const SAVE_MESSAGES: Record<SaveResult, string | null> = {
  saved: "Saved.",
  shared: null,
  downloaded: "Downloaded to your device.",
  cancelled: null,
};
