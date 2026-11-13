// Decoded page background images, shared by the editor, thumbnails, exports and AI snapshots.
// Pixels are stored compressed in IndexedDB; a decoded letter page at 2x is ~14 MB of RAM, so only a
// handful stay decoded at once (least recently used goes first). Callers that render off screen
// (exports, thumbnails, AI) await loadBackground() first; the editor draws what is ready and
// re-renders when onBackgroundReady fires.
import { getAsset } from "./store";
import type { Page } from "./types";

export type BackgroundImage = ImageBitmap | HTMLImageElement;

const MAX_DECODED = 6;
const decoded = new Map<string, BackgroundImage>(); // insertion order = recency
const loading = new Map<string, Promise<BackgroundImage | null>>();
const missing = new Set<string>();
const listeners = new Set<(ref: string) => void>();

function release(img: BackgroundImage) {
  if ("close" in img) img.close();
  else img.src = "";
}

function remember(ref: string, img: BackgroundImage) {
  decoded.delete(ref);
  decoded.set(ref, img);
  while (decoded.size > MAX_DECODED) {
    const [oldest, old] = decoded.entries().next().value as [string, BackgroundImage];
    decoded.delete(oldest);
    release(old);
  }
}

async function decode(blob: Blob): Promise<BackgroundImage> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall back to an <img>, below
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded <img> keeps its pixels; the URL is no longer needed.
    URL.revokeObjectURL(url);
  }
}

/** The decoded image if it is ready; otherwise starts loading it and returns null. */
export function backgroundImage(ref: string): BackgroundImage | null {
  const hit = decoded.get(ref);
  if (hit) {
    remember(ref, hit);
    return hit;
  }
  if (!missing.has(ref)) void loadBackground(ref);
  return null;
}

/** true when this image could not be found or decoded; renderers then stop waiting for it. */
export function backgroundMissing(ref: string): boolean {
  return missing.has(ref);
}

export function loadBackground(ref: string): Promise<BackgroundImage | null> {
  const hit = decoded.get(ref);
  if (hit) {
    remember(ref, hit);
    return Promise.resolve(hit);
  }
  if (missing.has(ref)) return Promise.resolve(null);
  let job = loading.get(ref);
  if (!job) {
    job = (async () => {
      try {
        const blob = await getAsset(ref);
        if (!blob) throw new Error("missing");
        const img = await decode(blob);
        remember(ref, img);
        return img;
      } catch {
        missing.add(ref);
        return null;
      } finally {
        loading.delete(ref);
        for (const fn of listeners) fn(ref);
      }
    })();
    loading.set(ref, job);
  }
  return job;
}

/** Makes sure this page's background is decoded, so a synchronous render right after includes it. */
export async function prepareBackground(page: Page | undefined): Promise<void> {
  if (page?.bg) await loadBackground(page.bg.ref);
}

export function onBackgroundReady(fn: (ref: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Drops decoded copies (and "missing" marks), e.g. after their images were deleted or restored. */
export function forgetBackgrounds(refs?: Iterable<string>) {
  const list = refs ? Array.from(refs) : Array.from(decoded.keys()).concat(Array.from(missing));
  for (const ref of list) {
    const img = decoded.get(ref);
    if (img) release(img);
    decoded.delete(ref);
    missing.delete(ref);
  }
}
