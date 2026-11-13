// .leaf files: a whole notebook as plain JSON, so it opens anywhere Looseleaf runs.
import { backgroundMissing, prepareBackground } from "./backgrounds";
import { pageToCanvas } from "./render";
import { assetRefs, deleteAssets, getAsset, putAsset } from "./store";
import { COVERS, PAGE_H, PAGE_W, uid, type Item, type Notebook, type Page, type PageBackground, type Paper } from "./types";

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

// ---------- background images in .leaf files ----------
//
// A .leaf file carries its page images (imported PDF pages) in a top-level "assets" map of
// ref -> data URL, so the file opens anywhere. Older Looseleaf versions ignore the map (and the
// pages' "bg"), so they still open such a file, without the backgrounds.

/** Per image. A 2x page from a PDF import is well under 1 MB. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/**
 * Per image, decoded. A small file can still declare a vast image (a blank PNG compresses ~1000:1),
 * and decoding it would take gigabytes, so the header's size is checked first. A PDF import makes at most 4.5 MP.
 */
export const MAX_ASSET_PIXELS = 6_000_000;
const MAX_ASSET_SIDE = 8192;
const ASSET_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Checks the file's first bytes really are the image type it claims. */
function magicMatches(type: string, b: Uint8Array): boolean {
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  // RIFF....WEBP
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
}

/** Width and height from a JPEG, PNG or WebP header, or null if they can't be read. */
export function imageSize(type: string, b: Uint8Array): { w: number; h: number } | null {
  if (type === "image/png") {
    if (b.length < 24) return null;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (type === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2; // markers without a length
        continue;
      }
      // Start of frame (any kind except DHT C4, JPG C8, DAC CC) carries the size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === "VP8 ") return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
  if (chunk === "VP8L") return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  if (chunk === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  return null;
}

/** A data URL from an untrusted file, as an image Blob, or null when it is anything else or too big. */
export function decodeAsset(value: unknown): Blob | null {
  if (typeof value !== "string") return null;
  const m = DATA_URL.exec(value.slice(0, 40));
  if (!m || !(ASSET_TYPES as readonly string[]).includes(m[1])) return null;
  const b64 = value.slice(m[0].length);
  if (b64.length < 16 || b64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || b64.length % 4 !== 0 || !BASE64.test(b64)) return null;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  if (bin.length > MAX_ASSET_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (!magicMatches(m[1], bytes)) return null;
  const size = imageSize(m[1], bytes);
  if (!size || size.w < 1 || size.h < 1 || size.w > MAX_ASSET_SIDE || size.h > MAX_ASSET_SIDE || size.w * size.h > MAX_ASSET_PIXELS) return null;
  return new Blob([bytes], { type: m[1] });
}

const REF = /^[A-Za-z0-9_-]{1,64}$/;

function cleanBackground(raw: unknown): PageBackground | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "image" || typeof r.ref !== "string" || !REF.test(r.ref)) return null;
  const w = num(r.w, 0, 0, 20000);
  const h = num(r.h, 0, 0, 20000);
  if (w < 1 || h < 1) return null;
  return { kind: "image", ref: r.ref, w, h };
}

export interface ParsedLeaf {
  notebook: Notebook;
  /**
   * The data URLs the notebook's pages use, by ref, only checked to look like an allowed image type.
   * importLeaf decodes and fully validates them one at a time, so a long PDF never sits in memory
   * twice over as decoded images.
   */
  assets: Map<string, string>;
}

/** Reads untrusted file text into a notebook. Throws an Error with a message fit to show the user. */
export function parseLeaf(text: string): Notebook {
  return parseLeafWithAssets(text).notebook;
}

/** Like parseLeaf, plus the background images the file carries. Pages whose image is missing lose just their background. */
export function parseLeafWithAssets(text: string): ParsedLeaf {
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
  const rawAssets = raw.assets && typeof raw.assets === "object" && !Array.isArray(raw.assets) ? (raw.assets as Record<string, unknown>) : {};
  const assets = new Map<string, string>();
  const pages: Page[] = (raw.pages as unknown[]).slice(0, 2000).map((p) => {
    const page = (p ?? {}) as Record<string, unknown>;
    const items = Array.isArray(page.items) ? page.items.map(cleanItem).filter((i): i is Item => !!i) : [];
    const out: Page = {
      id: uid(), // page ids are internal; fresh ones rule out duplicates in a hand-edited file
      paper: PAPERS.includes(page.paper as Paper) ? (page.paper as Paper) : "ruled",
      items,
    };
    const bg = cleanBackground(page.bg);
    if (bg && Object.prototype.hasOwnProperty.call(rawAssets, bg.ref)) {
      const value = rawAssets[bg.ref];
      if (typeof value === "string" && DATA_URL.test(value.slice(0, 40))) {
        assets.set(bg.ref, value);
        out.bg = bg;
      }
    }
    return out;
  });
  const now = Date.now();
  const notebook: Notebook = {
    format: "looseleaf",
    version: 1,
    id: uid(), // always a fresh id: importing never overwrites a notebook already in this browser
    title: str(raw.title, "Imported notebook", 200) || "Imported notebook",
    cover: typeof raw.cover === "string" && COLOR.test(raw.cover) ? raw.cover : COVERS[0],
    createdAt: num(raw.createdAt, now, 0, 1e14),
    updatedAt: now,
    pages: pages.length ? pages : [{ id: uid(), paper: "ruled", items: [] }],
  };
  return { notebook, assets };
}

/** Biggest .leaf file read into memory. A 300-page PDF notebook exports to roughly 150 MB. */
export const MAX_LEAF_BYTES = 400 * 1024 * 1024;

/**
 * Parses a .leaf file and stores its background images under fresh refs (so a file can never
 * overwrite images another notebook uses). Images that fail validation are dropped, along with just
 * the backgrounds that used them. Returns the notebook, ready to save, and the refs it stored (to
 * delete again if saving the notebook fails).
 */
export async function importLeaf(text: string): Promise<{ notebook: Notebook; stored: string[] }> {
  const { notebook, assets } = parseLeafWithAssets(text);
  if (!assets.size) return { notebook, stored: [] };
  const fresh = new Map<string, string>();
  try {
    for (const [ref, url] of assets) {
      const blob = decodeAsset(url); // one image decoded at a time
      if (!blob) continue;
      const next = uid();
      await putAsset(next, blob);
      fresh.set(ref, next);
    }
  } catch (e) {
    await deleteAssets(fresh.values()).catch(() => {});
    if ((e as Error)?.name === "QuotaExceededError") throw new Error("This browser is out of storage space for this notebook's pages.");
    throw new Error("Couldn't store this notebook's page images in this browser.");
  }
  const pages = notebook.pages.map((p) => {
    if (!p.bg) return p;
    const ref = fresh.get(p.bg.ref);
    if (ref) return { ...p, bg: { ...p.bg, ref } };
    const { bg: _dropped, ...rest } = p; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  });
  return { notebook: { ...notebook, pages }, stored: [...fresh.values()] };
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

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The notebook as a .leaf file, its page images embedded as data URLs. Built from Blob parts, one
 * per image, so a long PDF never has to exist as a single giant string in memory.
 */
export async function leafBlob(nb: Notebook): Promise<Blob> {
  const json = JSON.stringify(nb);
  const refs = assetRefs(nb);
  if (!refs.size) return new Blob([json], { type: "application/json" });
  const parts: BlobPart[] = [json.slice(0, -1), ',"assets":{'];
  let first = true;
  for (const ref of refs) {
    const blob = await getAsset(ref);
    if (!blob) continue; // the page keeps its bg; importers drop a background with no image
    parts.push(new Blob([`${first ? "" : ","}${JSON.stringify(ref)}:"`, await dataUrl(blob), '"']));
    first = false;
  }
  parts.push("}}");
  return new Blob(parts, { type: "application/json" });
}

export async function exportLeaf(nb: Notebook): Promise<SaveResult> {
  return saveFile(await leafBlob(nb), `${safeName(nb.title)}.leaf`, "Looseleaf notebook");
}

export const BG_FAILED = "A PDF page's image couldn't be loaded (the device may be low on memory). Close other tabs and try again.";

/** Throws rather than export a page whose PDF background exists but failed to load. */
async function needBackground(page: Page) {
  if (!(await prepareBackground(page)) && !backgroundMissing(page.bg!.ref)) throw new Error(BG_FAILED);
}

export async function exportPNG(nb: Notebook, pageIndex: number): Promise<SaveResult> {
  await needBackground(nb.pages[pageIndex]);
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
  // jsPDF holds every page image in memory until the end. Pages with a PDF background are photos
  // that compress worse than ink on paper, so long PDF notebooks get a lighter raster to stay within
  // iPad memory: still 1.5x (216 dpi) for more than 60 such pages.
  const heavy = nb.pages.filter((p) => p.bg).length > 60;
  for (let i = 0; i < nb.pages.length; i++) {
    if (i > 0) pdf.addPage([w, h]);
    // Decoded one page at a time (lib/backgrounds.ts keeps only a few), so a long PDF stays within iPad memory.
    await needBackground(nb.pages[i]);
    const bg = !!nb.pages[i].bg;
    const canvas = pageToCanvas(nb.pages[i], bg && heavy ? 1.5 : 2);
    pdf.addImage(canvas.toDataURL("image/jpeg", bg ? 0.85 : 0.9), "JPEG", 0, 0, w, h);
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
