// Decoded page background images, shared by the editor, thumbnails, exports and AI snapshots.
// Pixels are stored compressed in IndexedDB; a decoded letter page at 2x is ~14 MB of RAM, so only a
// handful stay decoded at once (least recently used goes first, within a byte budget). Callers that render off screen
// (exports, thumbnails, AI) await loadBackground() first; the editor draws what is ready and
// re-renders when onBackgroundReady fires.
import { getAsset } from "./store";
import type { Page } from "./types";

export type BackgroundImage = ImageBitmap | HTMLImageElement;

/** Decoded pixels kept at once (RGBA bytes): ~7 letter pages or ~16 slides at 2x. At least two stay. */
const DECODED_BUDGET = 96 * 1024 * 1024;
const MIN_DECODED = 2;
/** A load that failed for a reason other than the image being gone (a decode under memory pressure, a storage hiccup) is retried. */
const RETRY_MS = 4000;
const MAX_ATTEMPTS = 3;
const decoded = new Map<string, BackgroundImage>(); // insertion order = recency
const loading = new Map<string, Promise<BackgroundImage | null>>();
const missing = new Set<string>();
const failures = new Map<string, number>();
const waiting = new Set<string>(); // failed once, retry scheduled
const listeners = new Set<(ref: string) => void>();

const bytesOf = (img: BackgroundImage) => img.width * img.height * 4;

function release(img: BackgroundImage) {
  if ("close" in img) img.close();
  else img.src = "";
}

function remember(ref: string, img: BackgroundImage) {
  decoded.delete(ref);
  decoded.set(ref, img);
  let total = 0;
  for (const d of decoded.values()) total += bytesOf(d);
  while (decoded.size > MIN_DECODED && total > DECODED_BUDGET) {
    const [oldest, old] = decoded.entries().next().value as [string, BackgroundImage];
    decoded.delete(oldest);
    total -= bytesOf(old);
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
  if (!missing.has(ref) && !loading.has(ref) && !waiting.has(ref)) void loadBackground(ref);
  return null;
}

/** true when this image is gone (or kept failing to decode); renderers then stop waiting for it. */
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
        if (!blob) {
          missing.add(ref);
          return null;
        }
        const img = await decode(blob);
        failures.delete(ref);
        remember(ref, img);
        return img;
      } catch {
        const attempts = (failures.get(ref) ?? 0) + 1;
        failures.set(ref, attempts);
        if (attempts >= MAX_ATTEMPTS) missing.add(ref);
        else {
          // Try again a little later; the listeners' re-render asks for it then.
          waiting.add(ref);
          setTimeout(() => {
            waiting.delete(ref);
            for (const fn of listeners) fn(ref);
          }, RETRY_MS);
        }
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

/**
 * Makes sure this page's background is decoded, so a synchronous render right after includes it.
 * Returns false when the page has a background that could not be loaded.
 */
export async function prepareBackground(page: Page | undefined): Promise<boolean> {
  if (!page?.bg) return true;
  const ref = page.bg.ref;
  waiting.delete(ref); // an explicit request (export, AI) retries at once
  if (failures.has(ref)) {
    // Gave up after decode failures (e.g. low memory), not because the image is gone: try again, and
    // if it still fails the caller sees a failure instead of a silently blank page.
    missing.delete(ref);
    failures.delete(ref);
  }
  return !!(await loadBackground(ref));
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
    failures.delete(ref);
  }
}
