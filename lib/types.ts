export type Tool = "pen" | "highlighter" | "eraser" | "lasso" | "text";
export type Paper = "blank" | "ruled" | "grid" | "dots";

/** A handwritten stroke. `pts` is a flat list of x, y, pressure triples in page units. */
export interface StrokeItem {
  id: string;
  type: "stroke";
  tool: "pen" | "highlighter";
  color: string;
  size: number;
  pts: number[];
  /** true when pressure came from a real stylus; otherwise it is simulated from speed */
  real?: boolean;
}

export interface TextItem {
  id: string;
  type: "text";
  x: number;
  y: number;
  w: number;
  text: string;
  color: string;
  size: number;
}

export type Item = StrokeItem | TextItem;

export interface Page {
  id: string;
  paper: Paper;
  items: Item[];
}

/** This is exactly what a .leaf file contains. */
export interface Notebook {
  format: "looseleaf";
  version: 1;
  id: string;
  title: string;
  cover: string;
  createdAt: number;
  updatedAt: number;
  pages: Page[];
}

export interface NotebookMeta {
  id: string;
  title: string;
  cover: string;
  updatedAt: number;
  pageCount: number;
  thumb?: string;
}

/** US Letter at 96 dpi. Every page is this size in page units. */
export const PAGE_W = 816;
export const PAGE_H = 1056;
export const PAGE_GAP = 28;

export const COVERS = ["#2F7D4F", "#1D4ED8", "#C2410C", "#7A3FF2", "#B4235A", "#3F3F46"];

export const PEN_COLORS = ["#1F1F1F", "#1D4ED8", "#D92D20", "#1F8A4C", "#7A3FF2", "#E8710A"];
export const HIGHLIGHT_COLORS = ["#FFE14D", "#9BE37F", "#FF9EC7", "#8FD3FF", "#FFB870"];
export const PEN_SIZES = [2.5, 4, 7];
export const HIGHLIGHT_SIZES = [14, 22, 32];

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
    : Math.random().toString(36).slice(2) + Date.now().toString(36);

export function newPage(paper: Paper = "ruled"): Page {
  return { id: uid(), paper, items: [] };
}

export function newNotebook(title = "Untitled notebook", cover = COVERS[0]): Notebook {
  const now = Date.now();
  return {
    format: "looseleaf",
    version: 1,
    id: uid(),
    title,
    cover,
    createdAt: now,
    updatedAt: now,
    pages: [newPage()],
  };
}
