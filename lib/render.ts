// Turning notebook data into pixels. Shared by the editor, thumbnails, exports and AI snapshots.
import { getStroke } from "perfect-freehand";
import { PAGE_H, PAGE_W, type Item, type Page, type Paper, type StrokeItem, type TextItem } from "./types";

export const PAPER_COLOR = "#FFFDF8";
export const TEXT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const TEXT_LINE = 1.4;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function freehandOptions(size: number, real: boolean | undefined, last: boolean) {
  return real
    ? { size: size * 1.7, thinning: 0.6, smoothing: 0.5, streamline: 0.32, simulatePressure: false, last }
    : { size: size * 1.25, thinning: 0.45, smoothing: 0.5, streamline: 0.42, simulatePressure: true, last };
}

function triples(pts: number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < pts.length; i += 3) out.push([pts[i], pts[i + 1], pts[i + 2]]);
  return out;
}

/** Outline polygon from perfect-freehand, smoothed through midpoints. */
export function inkPath(pts: number[], size: number, real: boolean | undefined, last = true): Path2D {
  const outline = getStroke(triples(pts), freehandOptions(size, real, last));
  const path = new Path2D();
  if (!outline.length) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

/** Centre line for the highlighter, which is drawn as one constant-width stroke. */
export function centerPath(pts: number[]): Path2D {
  const path = new Path2D();
  if (pts.length < 3) return path;
  path.moveTo(pts[0], pts[1]);
  if (pts.length === 3) {
    path.lineTo(pts[0] + 0.01, pts[1]);
    return path;
  }
  for (let i = 3; i < pts.length - 3; i += 3) {
    path.quadraticCurveTo(pts[i], pts[i + 1], (pts[i] + pts[i + 3]) / 2, (pts[i + 1] + pts[i + 4]) / 2);
  }
  path.lineTo(pts[pts.length - 3], pts[pts.length - 2]);
  return path;
}

const pathCache = new WeakMap<StrokeItem, Path2D>();

export function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeItem, live = false) {
  let path = live ? undefined : pathCache.get(s);
  if (!path) {
    path = s.tool === "pen" ? inkPath(s.pts, s.size, s.real, !live) : centerPath(s.pts);
    if (!live) pathCache.set(s, path);
  }
  if (s.tool === "pen") {
    ctx.fillStyle = s.color;
    ctx.fill(path);
  } else {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(path);
    ctx.restore();
  }
}

let measure: CanvasRenderingContext2D | null = null;
function measureCtx(): CanvasRenderingContext2D {
  if (!measure) measure = document.createElement("canvas").getContext("2d")!;
  return measure;
}

const layoutCache = new WeakMap<TextItem, { lines: string[]; h: number }>();

export function layoutText(t: TextItem): { lines: string[]; h: number } {
  const hit = layoutCache.get(t);
  if (hit) return hit;
  const ctx = measureCtx();
  ctx.font = `${t.size}px ${TEXT_FONT}`;
  const lines: string[] = [];
  for (const para of t.text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= t.w || !line) {
        line = next;
        // A single word wider than the box: break it by characters.
        while (ctx.measureText(line).width > t.w && line.length > 1) {
          // Binary search for the longest prefix that fits, so one huge token cannot hang the tab.
          let lo = 1;
          let hi = line.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(line.slice(0, mid)).width <= t.w) lo = mid;
            else hi = mid - 1;
          }
          lines.push(line.slice(0, lo));
          line = line.slice(lo);
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  const out = { lines, h: Math.max(1, lines.length) * t.size * TEXT_LINE };
  layoutCache.set(t, out);
  return out;
}

export function drawText(ctx: CanvasRenderingContext2D, t: TextItem) {
  const { lines } = layoutText(t);
  ctx.font = `${t.size}px ${TEXT_FONT}`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = "top";
  const lh = t.size * TEXT_LINE;
  const pad = (lh - t.size) / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], t.x, t.y + i * lh + pad);
}

export function drawItem(ctx: CanvasRenderingContext2D, item: Item) {
  if (item.type === "stroke") drawStroke(ctx, item);
  else drawText(ctx, item);
}

const boundsCache = new WeakMap<Item, Box>();

export function itemBounds(item: Item): Box {
  const hit = boundsCache.get(item);
  if (hit) return hit;
  let box: Box;
  if (item.type === "text") {
    box = { x: item.x, y: item.y, w: item.w, h: layoutText(item).h };
  } else {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < item.pts.length; i += 3) {
      x0 = Math.min(x0, item.pts[i]);
      y0 = Math.min(y0, item.pts[i + 1]);
      x1 = Math.max(x1, item.pts[i]);
      y1 = Math.max(y1, item.pts[i + 1]);
    }
    const pad = item.size;
    box = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }
  boundsCache.set(item, box);
  return box;
}

export function unionBounds(items: Item[]): Box | null {
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    const b = itemBounds(it);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function drawPaper(ctx: CanvasRenderingContext2D, paper: Paper) {
  ctx.fillStyle = PAPER_COLOR;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  if (paper === "ruled") {
    ctx.strokeStyle = "rgba(50, 85, 140, 0.17)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 112; y < PAGE_H - 40; y += 34) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(PAGE_W, y + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(210, 70, 70, 0.22)";
    ctx.beginPath();
    ctx.moveTo(84.5, 0);
    ctx.lineTo(84.5, PAGE_H);
    ctx.stroke();
  } else if (paper === "grid") {
    ctx.strokeStyle = "rgba(50, 85, 140, 0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 24; x < PAGE_W; x += 24) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, PAGE_H);
    }
    for (let y = 24; y < PAGE_H; y += 24) {
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(PAGE_W, y + 0.5);
    }
    ctx.stroke();
  } else if (paper === "dots") {
    ctx.fillStyle = "rgba(50, 60, 85, 0.3)";
    for (let x = 24; x < PAGE_W; x += 24) {
      for (let y = 24; y < PAGE_H; y += 24) ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

/** Draws a whole page in page units. The caller sets the transform. */
export function renderPage(ctx: CanvasRenderingContext2D, page: Page, skip?: Set<string>, clip?: Box) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  drawPaper(ctx, page.paper);
  for (const item of page.items) {
    if (skip?.has(item.id)) continue;
    if (clip) {
      const b = itemBounds(item);
      if (b.x > clip.x + clip.w || b.x + b.w < clip.x || b.y > clip.y + clip.h || b.y + b.h < clip.y) continue;
    }
    drawItem(ctx, item);
  }
  ctx.restore();
}

/** A page as an image. Used for thumbnails, PNG/PDF export and what the AI sees. */
export function pageToCanvas(page: Page, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(PAGE_W * scale);
  canvas.height = Math.round(PAGE_H * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  renderPage(ctx, page);
  return canvas;
}

/** Just the given items, cropped tight, on plain paper. This is what a lasso sends to the AI. */
export function itemsToCanvas(items: Item[], maxSide = 1400): HTMLCanvasElement | null {
  const b = unionBounds(items);
  if (!b) return null;
  const pad = 24;
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  const scale = Math.min(3, maxSide / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(pad - b.x, pad - b.y);
  for (const item of items) drawItem(ctx, item);
  return canvas;
}

// ---------- geometry ----------

export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Does the point come within `radius` of the item? */
export function hitItem(item: Item, x: number, y: number, radius: number): boolean {
  const b = itemBounds(item);
  if (x < b.x - radius || x > b.x + b.w + radius || y < b.y - radius || y > b.y + b.h + radius) return false;
  if (item.type === "text") return true;
  const reach = radius + item.size / 2;
  const p = item.pts;
  if (p.length === 3) return Math.hypot(x - p[0], y - p[1]) <= reach;
  for (let i = 0; i < p.length - 3; i += 3) {
    if (distToSegment(x, y, p[i], p[i + 1], p[i + 3], p[i + 4]) <= reach) return true;
  }
  return false;
}

export function itemInPolygon(item: Item, poly: number[]): boolean {
  if (item.type === "text") {
    const b = itemBounds(item);
    return pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, poly);
  }
  let inside = 0;
  const total = item.pts.length / 3;
  for (let i = 0; i < item.pts.length; i += 3) {
    if (pointInPolygon(item.pts[i], item.pts[i + 1], poly)) inside++;
  }
  return inside / total >= 0.6;
}

export function translateItem<T extends Item>(item: T, dx: number, dy: number, freshId?: string): T {
  if (item.type === "text") return { ...item, id: freshId ?? item.id, x: item.x + dx, y: item.y + dy };
  const pts = item.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] += dx;
    pts[i + 1] += dy;
  }
  return { ...item, id: freshId ?? item.id, pts };
}
