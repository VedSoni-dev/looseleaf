// The ink engine: owns two canvases, the camera, pointer input, selection and undo.
// React only renders chrome around it and calls the public methods.
import { backgroundImage, onBackgroundReady, prepareBackground } from "./backgrounds";
import {
  drawItem,
  drawStroke,
  hitItem,
  itemBounds,
  itemInPolygon,
  itemsToCanvas,
  layoutText,
  pageToCanvas,
  renderPage,
  translateItem,
  unionBounds,
  TEXT_LINE,
  type Box,
} from "./render";
import {
  HIGHLIGHT_COLORS,
  HIGHLIGHT_SIZES,
  PAGE_GAP,
  PAGE_H,
  PAGE_W,
  PEN_COLORS,
  PEN_SIZES,
  newPage,
  uid,
  type Item,
  type Notebook,
  type Page,
  type Paper,
  type StrokeItem,
  type TextItem,
  type Tool,
} from "./types";

export interface EngineState {
  canUndo: boolean;
  canRedo: boolean;
  pageIndex: number;
  pageCount: number;
  zoom: number;
  selection: number;
  fingerDraws: boolean;
  paper: Paper;
  tool: Tool;
}

export interface TextEdit {
  item: TextItem;
  pageIndex: number;
  isNew: boolean;
}

export interface EngineHost {
  onState(state: EngineState): void;
  onChange(doc: Notebook): void;
  onToast(message: string): void;
  onTextEdit(edit: TextEdit | null): void;
}

interface Pt {
  x: number;
  y: number;
}

interface View {
  x: number;
  y: number;
  z: number;
}

type Action =
  | { kind: "draw"; id: number; ptype: string; page: number; pts: number[]; predicted: number[]; tool: "pen" | "highlighter"; real: boolean }
  | { kind: "erase"; id: number; ptype: string; snapped: boolean; x: number; y: number; last: Pt | null }
  | { kind: "lasso"; id: number; ptype: string; page: number; pts: number[] }
  | { kind: "move"; id: number; ptype: string; sx: number; sy: number; dx: number; dy: number }
  | { kind: "tap"; id: number; ptype: string; x: number; y: number }
  | { kind: "pan"; id: number; ptype: string; lx: number; ly: number; start: View; vx: number; vy: number; t: number }
  | { kind: "pinch"; ptype: "touch"; start: View; d0: number; cx: number; cy: number };

interface PageCache {
  canvas: HTMLCanvasElement;
  scale: number;
  items: Item[];
  paper: Paper;
  bg: Page["bg"];
  /** false when it was drawn before its background image had loaded */
  complete: boolean;
}

const ROW = PAGE_H + PAGE_GAP;
const MAX_CACHE_AREA = 10_000_000; // stay well inside iOS Safari's canvas memory budget
const TOP_INSET = 84;
const BOTTOM_INSET = 120;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;
const ERASER_PX = 11;
const UNDO_LIMIT = 120;

const round2 = (n: number) => Math.round(n * 100) / 100;

export class InkEngine {
  doc: Notebook;
  tool: Tool = "pen";
  styles = {
    pen: { color: PEN_COLORS[0], size: PEN_SIZES[1] },
    highlighter: { color: HIGHLIGHT_COLORS[0], size: HIGHLIGHT_SIZES[1] },
  };
  fingerDraws = true;
  spaceDown = false;

  private view: View = { x: 0, y: 0, z: 1 };
  private bctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private fitted = false;

  private touches = new Map<number, Pt>();
  private ignoredTouches = new Set<number>();
  private penSeen = false;
  private action: Action | null = null;

  private selection: { page: number; ids: Set<string> } | null = null;
  private lift: { page: number; ids: Set<string> } | null = null;
  private editing: TextEdit | null = null;

  private caches = new Map<string, PageCache>();
  private undoStack: Page[][] = [];
  private redoStack: Page[][] = [];

  private baseDirty = false;
  private overlayDirty = false;
  private raf = 0;
  private zooming = false;
  private zoomTimer: ReturnType<typeof setTimeout> | null = null;
  private inertia = 0;
  private pageIndex = 0;
  private gestureZoom = 1;
  private desk = "#ECE9E2";
  private accent = "#2F7D4F";
  private resizeObserver: ResizeObserver;
  private destroyed = false;
  private stopBackgrounds: () => void;

  constructor(
    private base: HTMLCanvasElement,
    private overlay: HTMLCanvasElement,
    doc: Notebook,
    private host: EngineHost,
  ) {
    this.doc = doc;
    this.bctx = base.getContext("2d", { alpha: false })!;
    this.octx = overlay.getContext("2d", { desynchronized: true })!;
    this.readTheme();

    overlay.addEventListener("pointerdown", this.onDown);
    overlay.addEventListener("pointermove", this.onMove);
    overlay.addEventListener("pointerup", this.onUp);
    overlay.addEventListener("pointercancel", this.onCancel);
    overlay.addEventListener("wheel", this.onWheel, { passive: false });
    // iOS Safari: without these the text loupe and double-tap zoom still sneak through.
    overlay.addEventListener("touchstart", this.block, { passive: false });
    overlay.addEventListener("touchmove", this.block, { passive: false });
    overlay.addEventListener("contextmenu", this.block);
    overlay.addEventListener("gesturestart", this.onGesture as EventListener, { passive: false });
    overlay.addEventListener("gesturechange", this.onGesture as EventListener, { passive: false });

    // A page image finished decoding: redraw so it replaces its placeholder.
    this.stopBackgrounds = onBackgroundReady((ref) => {
      if (this.doc.pages.some((p) => p.bg?.ref === ref)) this.renderAll();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(overlay);
    this.resize();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.inertia);
    if (this.zoomTimer) clearTimeout(this.zoomTimer);
    this.resizeObserver.disconnect();
    this.stopBackgrounds();
    const o = this.overlay;
    o.removeEventListener("pointerdown", this.onDown);
    o.removeEventListener("pointermove", this.onMove);
    o.removeEventListener("pointerup", this.onUp);
    o.removeEventListener("pointercancel", this.onCancel);
    o.removeEventListener("wheel", this.onWheel);
    o.removeEventListener("touchstart", this.block);
    o.removeEventListener("touchmove", this.block);
    o.removeEventListener("contextmenu", this.block);
    o.removeEventListener("gesturestart", this.onGesture as EventListener);
    o.removeEventListener("gesturechange", this.onGesture as EventListener);
    this.caches.clear();
  }

  // ---------- public API ----------

  state(): EngineState {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      pageIndex: this.pageIndex,
      pageCount: this.doc.pages.length,
      zoom: this.view.z,
      selection: this.selection?.ids.size ?? 0,
      fingerDraws: this.fingerDraws,
      paper: this.doc.pages[this.pageIndex]?.paper ?? "ruled",
      tool: this.tool,
    };
  }

  setTool(tool: Tool) {
    if (this.tool === tool) return;
    this.tool = tool;
    if (tool !== "lasso") this.clearSelection();
    this.emit();
  }

  setFingerDraws(on: boolean) {
    this.fingerDraws = on;
    this.emit();
  }

  readTheme() {
    const css = getComputedStyle(document.documentElement);
    this.desk = css.getPropertyValue("--desk").trim() || this.desk;
    this.accent = css.getPropertyValue("--accent").trim() || this.accent;
    this.renderAll();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.doc.pages);
    this.restore(prev);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.doc.pages);
    this.restore(next);
  }

  /** Adds pages (e.g. from a PDF) after the current one and scrolls to the first of them. */
  insertPages(added: Page[]) {
    if (!added.length) return;
    const at = Math.min(this.pageIndex, this.doc.pages.length - 1);
    this.selection = null;
    const pages = this.doc.pages.slice();
    pages.splice(at + 1, 0, ...added);
    this.mutate(pages);
    this.scrollToPage(at + 1);
  }

  addPage() {
    const at = Math.min(this.pageIndex, this.doc.pages.length - 1);
    this.selection = null;
    const pages = this.doc.pages.slice();
    pages.splice(at + 1, 0, newPage(this.doc.pages[at]?.paper ?? "ruled"));
    this.mutate(pages);
    this.scrollToPage(at + 1);
  }

  deletePage() {
    const at = this.pageIndex;
    this.clearSelection();
    if (this.doc.pages.length === 1) {
      this.mutate([{ ...this.doc.pages[0], items: [] }]);
      return;
    }
    this.mutate(this.doc.pages.filter((_, i) => i !== at));
    this.scrollToPage(Math.min(at, this.doc.pages.length - 1));
  }

  setPaper(paper: Paper) {
    const at = this.pageIndex;
    this.mutate(this.doc.pages.map((p, i) => (i === at ? { ...p, paper } : p)));
  }

  setTitle(title: string) {
    this.doc = { ...this.doc, title, updatedAt: Date.now() };
    this.host.onChange(this.doc);
  }

  scrollToPage(i: number) {
    const index = Math.max(0, Math.min(this.doc.pages.length - 1, i));
    this.view.y = TOP_INSET - index * ROW * this.view.z;
    this.clampView();
    this.renderAll();
  }

  zoomBy(factor: number) {
    this.zoomAt({ x: this.w / 2, y: this.h / 2 }, this.view.z * factor);
  }

  fit() {
    const margin = this.w < 700 ? 10 : 36;
    this.view.z = Math.max(MIN_ZOOM, Math.min(1.5, (this.w - margin * 2) / PAGE_W));
    const anchor = this.pageIndex;
    this.view.x = (this.w - PAGE_W * this.view.z) / 2;
    this.view.y = TOP_INSET - anchor * ROW * this.view.z;
    this.clampView();
    this.markZooming();
    this.renderAll();
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    this.mutatePage(sel.page, (items) => items.filter((it) => !sel.ids.has(it.id)));
  }

  duplicateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const copies = this.selectedItems().map((it) => translateItem(it, 22, 22, uid()));
    this.mutatePage(sel.page, (items) => [...items, ...copies]);
    this.selection = { page: sel.page, ids: new Set(copies.map((c) => c.id)) };
    this.renderAll();
    this.emit();
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.renderOverlay();
    this.emit();
  }

  /** JPEG data URL of the lassoed items, for the AI. */
  async selectionImage(): Promise<string | null> {
    const sel = this.selection;
    const page = sel ? this.doc.pages[sel.page] : undefined;
    const items = this.selectedItems();
    await prepareBackground(page);
    const canvas = itemsToCanvas(items, 1400, page);
    return canvas ? canvas.toDataURL("image/jpeg", 0.88) : null;
  }

  /** JPEG data URL of the page in view (its PDF background included), for the AI. */
  async pageImage(index = this.pageIndex): Promise<string | null> {
    const page = this.doc.pages[index];
    if (!page) return null;
    await prepareBackground(page);
    return pageToCanvas(page, 1.5).toDataURL("image/jpeg", 0.85);
  }

  currentPageIsEmpty(): boolean {
    const page = this.doc.pages[this.pageIndex];
    return !page || (page.items.length === 0 && !page.bg);
  }

  /** Drops typed text onto the page: under the selection if there is one, else near the top of the view. */
  insertText(text: string) {
    const clean = text.trim();
    if (!clean) return;
    let page = this.pageIndex;
    let x = 100;
    let y = 60;
    const box = this.selection ? unionBounds(this.selectedItems()) : null;
    if (this.selection && box) {
      page = this.selection.page;
      x = Math.max(24, Math.min(box.x, PAGE_W - 300));
      y = box.y + box.h + 18;
    } else {
      const top = (TOP_INSET - this.view.y) / this.view.z - page * ROW;
      y = Math.max(48, Math.min(PAGE_H - 200, top + 40));
    }
    const make = (text: string, tx: number, ty: number): TextItem => ({
      id: uid(),
      type: "text",
      x: tx,
      y: ty,
      w: Math.min(PAGE_W - tx - 40, 620),
      text,
      color: PEN_COLORS[0],
      size: 17,
    });
    let item = make(clean, x, y);
    const margin = 32;
    const lineHeight = item.size * TEXT_LINE;
    const { lines, h } = layoutText(item);
    const perPage = Math.floor((PAGE_H - margin * 3) / lineHeight);
    this.tool = "lasso";
    if (lines.length <= perPage) {
      // Fits on this page: slide it up if it would run off the bottom.
      if (y + h > PAGE_H - margin) item = make(clean, x, Math.max(margin, PAGE_H - margin - h));
      const placed = item;
      this.mutatePage(page, (items) => [...items, placed]);
      this.selection = { page, ids: new Set([placed.id]) };
    } else {
      // Too long for one page: continue onto fresh pages rather than clipping the text.
      const pages = this.doc.pages.slice();
      const paper = pages[page].paper;
      const fresh: Page[] = [];
      for (let i = 0; i < lines.length; i += perPage) {
        fresh.push({ ...newPage(paper), items: [make(lines.slice(i, i + perPage).join("\n"), 100, margin * 1.5)] });
      }
      pages.splice(page + 1, 0, ...fresh);
      this.selection = null;
      this.mutate(pages);
      this.scrollToPage(page + 1);
    }
    this.renderAll();
    this.emit();
  }

  /** Where the text box being edited sits on screen, in CSS pixels. */
  textRect(edit: TextEdit): { left: number; top: number; width: number; fontSize: number; minHeight: number } {
    const { z } = this.view;
    return {
      left: this.view.x + edit.item.x * z,
      top: this.view.y + (edit.pageIndex * ROW + edit.item.y) * z,
      width: edit.item.w * z,
      fontSize: edit.item.size * z,
      minHeight: layoutText(edit.item).h * z,
    };
  }

  finishTextEdit(text: string) {
    const edit = this.editing;
    if (!edit) return;
    this.editing = null;
    this.lift = null;
    const clean = text.replace(/\s+$/, "");
    if (edit.isNew) {
      if (clean) this.mutatePage(edit.pageIndex, (items) => [...items, { ...edit.item, text: clean }]);
    } else if (!clean) {
      this.mutatePage(edit.pageIndex, (items) => items.filter((it) => it.id !== edit.item.id));
    } else if (clean !== edit.item.text) {
      this.mutatePage(edit.pageIndex, (items) => items.map((it) => (it.id === edit.item.id ? { ...edit.item, text: clean } : it)));
    }
    this.host.onTextEdit(null);
    this.renderAll();
  }

  // ---------- document mutation ----------

  private mutate(pages: Page[]) {
    this.undoStack.push(this.doc.pages);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.doc = { ...this.doc, pages, updatedAt: Date.now() };
    this.host.onChange(this.doc);
    this.renderAll();
    this.emit();
  }

  private mutatePage(index: number, fn: (items: Item[]) => Item[]) {
    this.mutate(this.doc.pages.map((p, i) => (i === index ? { ...p, items: fn(p.items) } : p)));
  }

  private restore(pages: Page[]) {
    this.selection = null;
    this.doc = { ...this.doc, pages, updatedAt: Date.now() };
    this.host.onChange(this.doc);
    this.clampView();
    this.renderAll();
    this.emit();
  }

  private selectedItems(): Item[] {
    const sel = this.selection;
    if (!sel) return [];
    return (this.doc.pages[sel.page]?.items ?? []).filter((it) => sel.ids.has(it.id));
  }

  private emit() {
    this.host.onState(this.state());
  }

  // ---------- camera ----------

  private resize() {
    const rect = this.overlay.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const firstLayout = !this.fitted;
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    if (firstLayout) {
      this.fitted = true;
      this.fit();
    } else {
      this.clampView();
    }
    // Draw now rather than next frame so a resize never flashes an empty canvas.
    this.drawBase();
    this.drawOverlay();
    this.emit();
  }

  private clampView() {
    const v = this.view;
    v.z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z));
    const cw = PAGE_W * v.z;
    const margin = 24;
    if (cw + margin * 2 <= this.w) v.x = (this.w - cw) / 2;
    else v.x = Math.max(this.w - cw - margin, Math.min(margin, v.x));
    const total = (this.doc.pages.length * ROW - PAGE_GAP) * v.z;
    const minY = Math.min(TOP_INSET, this.h - BOTTOM_INSET - total);
    v.y = Math.max(minY, Math.min(TOP_INSET, v.y));
  }

  private zoomAt(p: Pt, z: number) {
    const v = this.view;
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const wx = (p.x - v.x) / v.z;
    const wy = (p.y - v.y) / v.z;
    v.z = next;
    v.x = p.x - wx * next;
    v.y = p.y - wy * next;
    this.clampView();
    this.markZooming();
    this.renderAll();
    this.emit();
  }

  /** While zooming we stretch cached bitmaps; once it settles we re-rasterise crisply. */
  private markZooming() {
    this.zooming = true;
    if (this.zoomTimer) clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => {
      this.zooming = false;
      this.renderAll();
    }, 160);
  }

  private local(e: { clientX: number; clientY: number }): Pt {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toWorld(p: Pt): Pt {
    return { x: (p.x - this.view.x) / this.view.z, y: (p.y - this.view.y) / this.view.z };
  }

  private pageAt(w: Pt): number {
    if (w.x < 0 || w.x > PAGE_W || w.y < 0) return -1;
    const i = Math.floor(w.y / ROW);
    if (i >= this.doc.pages.length || w.y - i * ROW > PAGE_H) return -1;
    return i;
  }

  private visibleRange(): [number, number] {
    const top = -this.view.y / this.view.z;
    const bottom = (this.h - this.view.y) / this.view.z;
    const first = Math.max(0, Math.floor(top / ROW));
    const last = Math.min(this.doc.pages.length - 1, Math.floor(bottom / ROW));
    return [first, last];
  }

  // ---------- rendering ----------

  private renderAll() {
    this.baseDirty = true;
    this.overlayDirty = true;
    this.schedule();
  }

  private renderOverlay() {
    this.overlayDirty = true;
    this.schedule();
  }

  private schedule() {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.baseDirty) this.drawBase();
      if (this.overlayDirty) this.drawOverlay();
    });
  }

  private buildCache(page: Page, scale: number, prior?: PageCache): PageCache {
    const canvas = prior?.canvas ?? document.createElement("canvas");
    canvas.width = Math.round(PAGE_W * scale);
    canvas.height = Math.round(PAGE_H * scale);
    const ctx = canvas.getContext("2d", { alpha: false })!;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const complete = renderPage(ctx, page);
    const cache = { canvas, scale, items: page.items, paper: page.paper, bg: page.bg, complete };
    this.caches.set(page.id, cache);
    return cache;
  }

  private drawBase() {
    this.baseDirty = false;
    if (!this.w) return;
    const ctx = this.bctx;
    const { dpr, view } = this;
    const scale = view.z * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.desk;
    ctx.fillRect(0, 0, this.base.width, this.base.height);

    const [first, last] = this.visibleRange();
    const alive = new Set<string>();
    const pw = PAGE_W * scale;
    const ph = PAGE_H * scale;
    const cacheable = PAGE_W * PAGE_H * scale * scale <= MAX_CACHE_AREA;

    for (let i = first; i <= last; i++) {
      const page = this.doc.pages[i];
      alive.add(page.id);
      const px = Math.round(view.x * dpr);
      const py = Math.round((view.y + i * ROW * view.z) * dpr);

      ctx.save();
      ctx.shadowColor = "rgba(20, 16, 8, 0.16)";
      ctx.shadowBlur = 14 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.fillStyle = "#FFFDF8";
      ctx.fillRect(px, py, pw, ph);
      ctx.restore();

      const lifted = this.lift && this.lift.page === i ? this.lift.ids : undefined;
      let cache = this.caches.get(page.id);
      // A bitmap drawn while its background was loading stays good only until the image is ready.
      const fresh =
        !!cache &&
        cache.items === page.items &&
        cache.paper === page.paper &&
        cache.bg === page.bg &&
        (cache.complete || !page.bg || !backgroundImage(page.bg.ref));

      if (!lifted && cacheable) {
        const scaleOk = !!cache && Math.abs(cache.scale - scale) < 1e-4;
        if (!cache || !fresh || (!scaleOk && !this.zooming)) cache = this.buildCache(page, scale, cache);
        ctx.drawImage(cache.canvas, px, py, pw, ph);
      } else if (!lifted && fresh && cache && this.zooming) {
        ctx.drawImage(cache.canvas, px, py, pw, ph);
      } else {
        // Zoomed in past what a bitmap can hold (or items are lifted): draw vectors, culled to the viewport.
        const clip: Box = {
          x: -view.x / view.z,
          y: -(view.y + i * ROW * view.z) / view.z,
          w: this.w / view.z,
          h: this.h / view.z,
        };
        ctx.save();
        ctx.setTransform(scale, 0, 0, scale, px, py);
        renderPage(ctx, page, lifted, clip);
        ctx.restore();
      }
    }

    for (const id of this.caches.keys()) if (!alive.has(id)) this.caches.delete(id);

    const centre = (this.h / 2 - view.y) / view.z;
    const index = Math.max(0, Math.min(this.doc.pages.length - 1, Math.floor(centre / ROW)));
    if (index !== this.pageIndex) {
      this.pageIndex = index;
      this.emit();
    }
    if (this.editing) this.host.onTextEdit({ ...this.editing });
  }

  private pageTransform(ctx: CanvasRenderingContext2D, page: number) {
    const s = this.view.z * this.dpr;
    ctx.setTransform(s, 0, 0, s, Math.round(this.view.x * this.dpr), Math.round((this.view.y + page * ROW * this.view.z) * this.dpr));
  }

  private drawOverlay() {
    this.overlayDirty = false;
    const ctx = this.octx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const a = this.action;

    if (a?.kind === "draw") {
      ctx.save();
      this.pageTransform(ctx, a.page);
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      const style = this.styles[a.tool];
      const live: StrokeItem = {
        id: "live",
        type: "stroke",
        tool: a.tool,
        color: style.color,
        size: style.size,
        pts: a.predicted.length ? a.pts.concat(a.predicted) : a.pts,
        real: a.real,
      };
      drawStroke(ctx, live, true);
      ctx.restore();
    }

    if (a?.kind === "lasso" && a.pts.length >= 4) {
      ctx.save();
      this.pageTransform(ctx, a.page);
      ctx.beginPath();
      ctx.moveTo(a.pts[0], a.pts[1]);
      for (let i = 2; i < a.pts.length; i += 2) ctx.lineTo(a.pts[i], a.pts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = this.accent + "14";
      ctx.fill();
      ctx.lineWidth = 1.5 / this.view.z;
      ctx.setLineDash([6 / this.view.z, 5 / this.view.z]);
      ctx.strokeStyle = this.accent;
      ctx.stroke();
      ctx.restore();
    }

    if (a?.kind === "erase") {
      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(a.x, a.y, ERASER_PX, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = "rgba(40,40,40,0.55)";
      ctx.stroke();
      ctx.restore();
    }

    const sel = this.selection;
    if (sel) {
      const items = this.selectedItems();
      const box = unionBounds(items);
      if (box) {
        const dx = a?.kind === "move" ? a.dx : 0;
        const dy = a?.kind === "move" ? a.dy : 0;
        ctx.save();
        this.pageTransform(ctx, sel.page);
        ctx.translate(dx, dy);
        if (a?.kind === "move") for (const it of items) drawItem(ctx, it);
        const pad = 8 / this.view.z;
        ctx.lineWidth = 1.5 / this.view.z;
        ctx.setLineDash([6 / this.view.z, 5 / this.view.z]);
        ctx.strokeStyle = this.accent;
        ctx.fillStyle = this.accent + "12";
        ctx.beginPath();
        ctx.roundRect(box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2, 8 / this.view.z);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ---------- input ----------

  private block = (e: Event) => {
    e.preventDefault();
  };

  private onGesture = (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
    // Safari's trackpad pinch. Finger pinches on iPad are handled through pointer events instead.
    e.preventDefault();
    if (this.touches.size || this.ignoredTouches.size || this.action || !e.scale) return;
    if (e.type === "gesturestart") {
      this.gestureZoom = this.view.z;
      return;
    }
    // e.scale is cumulative since gesturestart, so always scale from the zoom we started at.
    const p = e.clientX != null && e.clientY != null ? this.local({ clientX: e.clientX, clientY: e.clientY }) : { x: this.w / 2, y: this.h / 2 };
    this.zoomAt(p, this.gestureZoom * e.scale);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(this.local(e), this.view.z * Math.exp(-e.deltaY * unit * 0.01));
      return;
    }
    this.view.x -= e.deltaX * unit;
    this.view.y -= e.deltaY * unit;
    this.clampView();
    this.renderAll();
  };

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {}
    cancelAnimationFrame(this.inertia);
    if (this.editing) {
      // This tap only dismisses the text box; its blur handler commits the text.
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    const p = this.local(e);

    if (e.pointerType === "pen") {
      if (!this.penSeen) {
        this.penSeen = true;
        if (this.fingerDraws) {
          this.fingerDraws = false;
          this.host.onToast("Pencil detected. Fingers now scroll and zoom.");
          this.emit();
        }
      }
      // A resting palm may already have started a pan or pinch: undo it and ignore those touches.
      if (this.action && this.action.ptype === "touch") {
        if (this.action.kind === "pan" || this.action.kind === "pinch") this.view = { ...this.action.start };
        this.cancelAction();
      }
      for (const id of this.touches.keys()) this.ignoredTouches.add(id);
      this.touches.clear();
    }

    if (e.pointerType === "touch") {
      if (this.action && this.action.ptype === "pen") {
        this.ignoredTouches.add(e.pointerId); // palm
        return;
      }
      this.touches.set(e.pointerId, p);
      if (this.touches.size >= 2) {
        this.startPinch();
        return;
      }
      if (!this.fingerDraws) {
        this.startPan(e, p);
        return;
      }
    }

    if (this.action) return;
    if ((e.pointerType === "mouse" && e.button === 1) || this.spaceDown) {
      this.startPan(e, p);
      return;
    }
    this.beginTool(e, p);
  };

  private startPan(e: PointerEvent, p: Pt) {
    this.action = { kind: "pan", id: e.pointerId, ptype: e.pointerType, lx: p.x, ly: p.y, start: { ...this.view }, vx: 0, vy: 0, t: e.timeStamp };
  }

  /** Drops whatever gesture is in flight without committing it, leaving no half-state behind. */
  private cancelAction() {
    const a = this.action;
    if (!a) return;
    // An erase has already changed the page: keep it, and make sure it gets saved.
    if (a.kind === "erase" && a.snapped) {
      this.host.onChange(this.doc);
      this.emit();
    }
    this.action = null;
    this.lift = null;
    this.renderAll();
  }

  private startPinch() {
    this.cancelAction();
    const [a, b] = [...this.touches.values()];
    this.action = {
      kind: "pinch",
      ptype: "touch",
      start: { ...this.view },
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
    this.renderOverlay();
  }

  private beginTool(e: PointerEvent, p: Pt) {
    const w = this.toWorld(p);
    const page = this.pageAt(w);
    const erasing = this.tool === "eraser" || (e.pointerType === "pen" && (e.buttons & 32) !== 0);
    const base = { id: e.pointerId, ptype: e.pointerType };

    if (erasing) {
      this.action = { kind: "erase", ...base, snapped: false, x: p.x, y: p.y, last: null };
      this.eraseAt(p);
      this.renderOverlay();
      return;
    }

    if (this.tool === "pen" || this.tool === "highlighter") {
      if (page < 0) return;
      const real = e.pointerType === "pen";
      const pressure = real ? Math.max(0.05, e.pressure * 0.6) : 0.5; // first Pencil samples are estimates: taper in
      this.action = {
        kind: "draw",
        ...base,
        page,
        tool: this.tool,
        real,
        predicted: [],
        pts: [w.x, w.y - page * ROW, pressure],
      };
      this.renderOverlay();
      return;
    }

    if (this.tool === "lasso") {
      const sel = this.selection;
      if (sel) {
        const box = unionBounds(this.selectedItems());
        const ly = w.y - sel.page * ROW;
        const pad = 10 / this.view.z;
        if (box && w.x >= box.x - pad && w.x <= box.x + box.w + pad && ly >= box.y - pad && ly <= box.y + box.h + pad) {
          this.action = { kind: "move", ...base, sx: w.x, sy: w.y, dx: 0, dy: 0 };
          this.lift = { page: sel.page, ids: sel.ids };
          this.renderAll();
          return;
        }
        this.selection = null;
        this.emit();
      }
      if (page < 0) {
        this.renderOverlay();
        return;
      }
      this.action = { kind: "lasso", ...base, page, pts: [w.x, w.y - page * ROW] };
      this.renderOverlay();
      return;
    }

    if (this.tool === "text") this.action = { kind: "tap", ...base, x: p.x, y: p.y };
  }

  private onMove = (e: PointerEvent) => {
    if (this.ignoredTouches.has(e.pointerId)) return;
    const a = this.action;
    const p = this.local(e);
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) this.touches.set(e.pointerId, p);
    if (!a) return;

    if (a.kind === "pinch") {
      if (this.touches.size < 2) return;
      const [t1, t2] = [...this.touches.values()];
      const d = Math.max(1, Math.hypot(t1.x - t2.x, t1.y - t2.y));
      const cx = (t1.x + t2.x) / 2;
      const cy = (t1.y + t2.y) / 2;
      const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (a.start.z * d) / a.d0));
      this.view.z = z;
      this.view.x = cx - ((a.cx - a.start.x) / a.start.z) * z;
      this.view.y = cy - ((a.cy - a.start.y) / a.start.z) * z;
      this.clampView();
      this.markZooming();
      this.renderAll();
      this.emit();
      return;
    }

    if (a.id !== e.pointerId) return;

    if (a.kind === "pan") {
      const dt = Math.max(1, e.timeStamp - a.t);
      const dx = p.x - a.lx;
      const dy = p.y - a.ly;
      a.vx = 0.6 * (dx / dt) + 0.4 * a.vx;
      a.vy = 0.6 * (dy / dt) + 0.4 * a.vy;
      a.lx = p.x;
      a.ly = p.y;
      a.t = e.timeStamp;
      this.view.x += dx;
      this.view.y += dy;
      this.clampView();
      this.renderAll();
      return;
    }

    if (a.kind === "draw") {
      // Safari delivers ~60 events/s; the coalesced list holds the Pencil's full 240 Hz trail.
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e]) this.addPoint(a, ev);
      a.predicted = [];
      const predicted = e.getPredictedEvents?.() ?? [];
      for (const ev of predicted.slice(0, 3)) {
        const w = this.toWorld(this.local(ev));
        a.predicted.push(w.x, w.y - a.page * ROW, a.real ? Math.max(0.05, ev.pressure) : 0.5);
      }
      this.renderOverlay();
      return;
    }

    if (a.kind === "erase") {
      a.x = p.x;
      a.y = p.y;
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e]) this.eraseAt(this.local(ev));
      this.renderOverlay();
      return;
    }

    if (a.kind === "lasso") {
      const w = this.toWorld(p);
      a.pts.push(w.x, w.y - a.page * ROW);
      this.renderOverlay();
      return;
    }

    if (a.kind === "move") {
      const w = this.toWorld(p);
      const box = unionBounds(this.selectedItems());
      a.dx = w.x - a.sx;
      a.dy = w.y - a.sy;
      // Pages clip their ink, so a selection may not be dragged off the page it lives on.
      if (box && box.w < PAGE_W) a.dx = Math.max(-box.x, Math.min(PAGE_W - box.x - box.w, a.dx));
      if (box && box.h < PAGE_H) a.dy = Math.max(-box.y, Math.min(PAGE_H - box.y - box.h, a.dy));
      this.renderOverlay();
    }
  };

  private addPoint(a: Extract<Action, { kind: "draw" }>, e: PointerEvent) {
    const w = this.toWorld(this.local(e));
    const x = w.x;
    const y = w.y - a.page * ROW;
    const n = a.pts.length;
    if (Math.hypot(x - a.pts[n - 3], y - a.pts[n - 2]) < 0.35) return;
    let pressure = 0.5;
    if (a.real) {
      pressure = Math.max(0.05, e.pressure);
      if (n < 9) pressure *= 0.6 + (n / 9) * 0.4;
    }
    a.pts.push(x, y, pressure);
  }

  private eraseAt(p: Pt) {
    const a = this.action;
    if (!a || a.kind !== "erase") return;
    const from = a.last ?? p;
    a.last = p;
    const steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) / (ERASER_PX * 0.8)));
    const radius = ERASER_PX / this.view.z;
    for (let s = 1; s <= steps; s++) {
      const w = this.toWorld({ x: from.x + ((p.x - from.x) * s) / steps, y: from.y + ((p.y - from.y) * s) / steps });
      const page = this.pageAt(w);
      if (page < 0) continue;
      const ly = w.y - page * ROW;
      const items = this.doc.pages[page].items;
      const kept = items.filter((it) => !hitItem(it, w.x, ly, radius));
      if (kept.length === items.length) continue;
      // One undo step for the whole swipe, however many strokes it removes.
      if (!a.snapped) {
        a.snapped = true;
        this.undoStack.push(this.doc.pages);
        this.redoStack = [];
      }
      this.doc = { ...this.doc, updatedAt: Date.now(), pages: this.doc.pages.map((pg, i) => (i === page ? { ...pg, items: kept } : pg)) };
      this.baseDirty = true;
    }
    if (this.baseDirty) this.schedule();
  }

  private onUp = (e: PointerEvent) => {
    if (this.ignoredTouches.delete(e.pointerId)) return;
    const wasTouch = this.touches.delete(e.pointerId);
    const a = this.action;
    if (!a) return;

    if (a.kind === "pinch") {
      if (!wasTouch) return;
      const rest = [...this.touches.entries()][0];
      // One finger left on the glass: carry on as a pan so the view does not jump.
      this.action = rest
        ? { kind: "pan", id: rest[0], ptype: "touch", lx: rest[1].x, ly: rest[1].y, start: { ...this.view }, vx: 0, vy: 0, t: e.timeStamp }
        : null;
      return;
    }

    if (a.id !== e.pointerId) return;
    this.action = null;

    if (a.kind === "pan") {
      if (e.timeStamp - a.t < 80 && Math.hypot(a.vx, a.vy) > 0.25) this.fling(a.vx, a.vy);
      return;
    }

    if (a.kind === "draw") {
      const style = this.styles[a.tool];
      const pts = a.pts.map(round2);
      const stroke: StrokeItem = { id: uid(), type: "stroke", tool: a.tool, color: style.color, size: style.size, pts };
      if (a.real) stroke.real = true;
      this.commitStroke(a.page, stroke);
      return;
    }

    if (a.kind === "erase") {
      if (a.snapped) {
        this.host.onChange(this.doc);
        this.emit();
      }
      this.renderAll();
      return;
    }

    if (a.kind === "lasso") {
      const page = this.doc.pages[a.page];
      let length = 0;
      for (let i = 2; i < a.pts.length; i += 2) length += Math.hypot(a.pts[i] - a.pts[i - 2], a.pts[i + 1] - a.pts[i - 1]);
      let ids: string[];
      if (length * this.view.z < 10) {
        // A tap: pick the top item under the finger.
        const hit = [...page.items].reverse().find((it) => hitItem(it, a.pts[0], a.pts[1], 8 / this.view.z));
        ids = hit ? [hit.id] : [];
      } else {
        ids = page.items.filter((it) => itemInPolygon(it, a.pts)).map((it) => it.id);
      }
      this.selection = ids.length ? { page: a.page, ids: new Set(ids) } : null;
      this.renderOverlay();
      this.emit();
      return;
    }

    if (a.kind === "move") {
      const sel = this.selection;
      this.lift = null;
      if (sel && (Math.abs(a.dx) > 0.5 || Math.abs(a.dy) > 0.5)) {
        this.mutatePage(sel.page, (items) => items.map((it) => (sel.ids.has(it.id) ? translateItem(it, round2(a.dx), round2(a.dy)) : it)));
      } else {
        this.renderAll();
      }
      return;
    }

    if (a.kind === "tap") {
      const p = this.local(e);
      if (Math.hypot(p.x - a.x, p.y - a.y) > 8) return;
      this.beginTextEdit(p);
    }
  };

  private onCancel = (e: PointerEvent) => {
    this.ignoredTouches.delete(e.pointerId);
    this.touches.delete(e.pointerId);
    const a = this.action;
    if (!a) return;
    if (a.kind === "pinch" ? this.touches.size < 2 : a.id === e.pointerId) {
      // A cancelled erase has already changed the page: keep it. Everything else is simply dropped.
      if (a.kind === "erase" && a.snapped) this.host.onChange(this.doc);
      this.action = null;
      this.lift = null;
      this.renderAll();
      this.emit();
    }
  };

  private commitStroke(pageIndex: number, stroke: StrokeItem) {
    const page = this.doc.pages[pageIndex];
    const items = [...page.items, stroke];
    // Fast path: paint the new stroke onto the cached page instead of re-rasterising everything.
    const cache = this.caches.get(page.id);
    if (cache && cache.items === page.items && cache.paper === page.paper) {
      const ctx = cache.canvas.getContext("2d", { alpha: false })!;
      ctx.save();
      ctx.setTransform(cache.scale, 0, 0, cache.scale, 0, 0);
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      drawStroke(ctx, stroke);
      ctx.restore();
      cache.items = items;
    }
    this.mutate(this.doc.pages.map((p, i) => (i === pageIndex ? { ...p, items } : p)));
  }

  private beginTextEdit(p: Pt) {
    const w = this.toWorld(p);
    const pageIndex = this.pageAt(w);
    if (pageIndex < 0) return;
    const ly = w.y - pageIndex * ROW;
    const existing = [...this.doc.pages[pageIndex].items].reverse().find((it): it is TextItem => {
      if (it.type !== "text") return false;
      const b = itemBounds(it);
      return w.x >= b.x - 6 && w.x <= b.x + b.w + 6 && ly >= b.y - 6 && ly <= b.y + b.h + 6;
    });
    if (existing) {
      this.editing = { item: existing, pageIndex, isNew: false };
      this.lift = { page: pageIndex, ids: new Set([existing.id]) };
    } else {
      const x = Math.min(w.x, PAGE_W - 160);
      const item: TextItem = {
        id: uid(),
        type: "text",
        x,
        y: ly - 12,
        w: Math.min(460, PAGE_W - x - 24),
        text: "",
        color: this.styles.pen.color,
        size: 18,
      };
      this.editing = { item, pageIndex, isNew: true };
    }
    this.host.onTextEdit(this.editing);
    this.renderAll();
  }

  private fling(vx: number, vy: number) {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const before = { ...this.view };
      this.view.x += vx * dt;
      this.view.y += vy * dt;
      this.clampView();
      const decay = Math.pow(0.994, dt);
      vx *= decay;
      vy *= decay;
      this.renderAll();
      const moved = Math.abs(this.view.x - before.x) + Math.abs(this.view.y - before.y);
      if (Math.hypot(vx, vy) > 0.03 && moved > 0.05 && !this.destroyed) this.inertia = requestAnimationFrame(step);
    };
    this.inertia = requestAnimationFrame(step);
  }
}
