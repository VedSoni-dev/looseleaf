// PDF import: each PDF page is rasterised once, here in the browser, into a JPEG stored in IndexedDB
// and shown under the ink as that Looseleaf page's background. Nothing is uploaded.
import { drawBackgroundImage, drawPaper } from "./render";
import { deleteAssets, putAsset } from "./store";
import { PAGE_H, PAGE_W, uid, type Page } from "./types";

export const MAX_PDF_PAGES = 300;
export const MAX_PDF_BYTES = 100 * 1024 * 1024;
/** Raster resolution: twice the page's units, so a page stays sharp on a 2x iPad screen. */
const RASTER = 2;
/** Upper bound on one page's pixels (a 2x US Letter page is ~3.4 MP), for odd page sizes. */
const MAX_PIXELS = 4_500_000;
const JPEG_QUALITY = 0.85;

export class PdfImportError extends Error {}

/**
 * A fresh pdf.js worker for one import, terminated afterwards so its memory goes back to the
 * device (and a crashed worker can't wedge later imports). The URL has to stay written out like
 * this: Turbopack spots `new Worker(new URL(..., import.meta.url))` and emits the worker as its own
 * hashed file under /_next/static, so it is cached with the app and works offline.
 */
function makeWorker(): Worker {
  return new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
}

export interface PdfProgress {
  done: number;
  total: number;
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

export function pdfTitle(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200) || "Imported PDF";
}

type PdfJs = typeof import("pdfjs-dist");
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    // The legacy build carries polyfills the modern one leaves out (Map.getOrInsertComputed and others)
    // that iPadOS Safari versions still in use lack.
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs")
      .then((mod) => mod as unknown as PdfJs)
      .catch((e) => {
        pdfjsPromise = null;
        throw e;
      });
  }
  return pdfjsPromise;
}

function friendly(e: unknown): Error {
  if (e instanceof PdfImportError) return e;
  const name = (e as { name?: string })?.name;
  if (name === "AbortError") return e as Error;
  if (name === "PasswordException") return new PdfImportError("This PDF is password-protected. Remove the password (e.g. Print → Save as PDF), then import it again.");
  if (name === "InvalidPDFException" || name === "FormatError") return new PdfImportError("This PDF looks damaged and couldn't be read.");
  if (name === "QuotaExceededError") return new PdfImportError("This browser is out of storage space for this PDF. Free some space or import fewer pages.");
  if (name === "ChunkLoadError" || /Loading chunk|dynamically imported module/i.test((e as Error)?.message ?? ""))
    return new PdfImportError("Couldn't load the PDF reader. Check your connection and try again.");
  return new PdfImportError("This PDF couldn't be imported. It may be damaged or use features Looseleaf can't read.");
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new PdfImportError("Couldn't render a page of this PDF."))), "image/jpeg", JPEG_QUALITY),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Turns a PDF file into Looseleaf pages with background images. Pages are rendered one at a time
 * into a single reused canvas and stored straight away, so memory stays flat however long the PDF.
 * Throws PdfImportError (message fit to show) or an AbortError when `signal` is aborted; either way
 * any images already stored are removed again.
 */
export async function pdfToPages(
  file: File,
  onProgress: (p: PdfProgress) => void,
  signal?: AbortSignal,
  maxPages = MAX_PDF_PAGES,
): Promise<{ pages: Page[]; thumb: string }> {
  if (file.size > MAX_PDF_BYTES) {
    throw new PdfImportError(`This PDF is ${Math.round(file.size / 1024 / 1024)} MB. Looseleaf imports PDFs up to ${MAX_PDF_BYTES / 1024 / 1024} MB.`);
  }
  if (file.size === 0) throw new PdfImportError("This PDF is empty.");
  const stored: string[] = [];
  const canvas = document.createElement("canvas");
  let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
  let port: Worker | null = null;
  let worker: import("pdfjs-dist").PDFWorker | null = null;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    // The PDF spec lets the header sit anywhere in the first 1 KB.
    const head = new TextDecoder("latin1").decode(data.subarray(0, 1024));
    if (!head.includes("%PDF-")) throw new PdfImportError("That file isn't a PDF.");
    const pdfjs = await loadPdfJs();
    signal?.throwIfAborted();
    // Fonts, CMaps and wasm decoders, copied into public/ by scripts/copy-pdfjs-assets.mjs.
    const assets = `/pdfjs/${pdfjs.version}/`;
    port = makeWorker();
    const workerFailed = new Promise<never>((_, reject) => {
      port!.addEventListener("error", () => reject(Object.assign(new Error("worker"), { name: "ChunkLoadError" })));
    });
    workerFailed.catch(() => {}); // only matters while racing the document load below
    worker = new pdfjs.PDFWorker({ port: port as never, verbosity: pdfjs.VerbosityLevel.ERRORS });
    loadingTask = pdfjs.getDocument({
      worker,
      data,
      enableXfa: false,
      cMapUrl: `${assets}cmaps/`,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      // A hostile PDF can declare huge images; skip any above 20 MP (80 MB decoded) instead of exhausting
      // memory. Pages are rasterised at 4.5 MP at most, so nothing bigger would show anyway.
      maxImageSize: 20_000_000,
    });
    // With a handler set, pdf.js asks it for the password instead of failing; turn that into an error.
    const task = loadingTask;
    const passwordHit = new Promise<never>((_, reject) => {
      task.onPassword = () => reject(Object.assign(new Error("password"), { name: "PasswordException" }));
    });
    const doc = await Promise.race([loadingTask.promise, passwordHit, workerFailed]);
    const total = doc.numPages;
    if (total > maxPages) {
      throw new PdfImportError(
        `This PDF has ${total} pages. Looseleaf imports up to ${maxPages} at a time; split it into smaller PDFs first.`,
      );
    }
    onProgress({ done: 0, total });

    const pages: Page[] = [];
    let thumb = "";
    for (let n = 1; n <= total; n++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const fit = Math.min(PAGE_W / base.width, PAGE_H / base.height);
      let scale = fit * RASTER;
      const px = base.width * base.height * scale * scale;
      if (px > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / px);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext("2d", { alpha: false })!;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        background: "#FFFFFF",
        annotationMode: pdfjs.AnnotationMode.ENABLE, // draw filled-in form fields and stamps too
      }).promise;
      page.cleanup();
      const blob = await toJpeg(canvas);
      const ref = uid();
      await putAsset(ref, blob);
      stored.push(ref);
      const bg = { kind: "image" as const, ref, w: canvas.width, h: canvas.height };
      pages.push({ id: uid(), paper: "blank", items: [], bg });
      if (n === 1) thumb = thumbnail(bg, canvas);
      onProgress({ done: n, total });
      await tick(); // let the progress paint and the browser breathe between pages
    }
    signal?.throwIfAborted(); // Cancel pressed during the last page still cancels
    if (!pages.length) throw new PdfImportError("This PDF has no pages.");
    return { pages, thumb };
  } catch (e) {
    if (stored.length) await deleteAssets(stored).catch(() => {});
    throw friendly(e);
  } finally {
    canvas.width = 0; // hand the bitmap back now: iPad Safari has a small canvas memory budget
    canvas.height = 0;
    // Destroying the loading task also frees the document and its data in the worker.
    if (loadingTask) await loadingTask.destroy().catch(() => {});
    worker?.destroy();
    port?.terminate();
  }
}

/** The library thumbnail for a notebook whose first page is this PDF page. Same scale as the library's own thumbs. */
function thumbnail(bg: { w: number; h: number }, img: CanvasImageSource): string {
  const scale = 0.3;
  const c = document.createElement("canvas");
  c.width = Math.round(PAGE_W * scale);
  c.height = Math.round(PAGE_H * scale);
  const ctx = c.getContext("2d")!;
  ctx.scale(scale, scale);
  drawPaper(ctx, "blank");
  drawBackgroundImage(ctx, bg, img);
  const url = c.toDataURL("image/jpeg", 0.72);
  c.width = 0;
  c.height = 0;
  return url;
}
