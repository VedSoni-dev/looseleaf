// Everything lives in this browser's IndexedDB. No account, no server.
import type { Notebook, NotebookMeta } from "./types";

const DB = "looseleaf";
const NOTEBOOKS = "notebooks";
const META = "meta";
/**
 * Page background images (imported PDF pages), keyed by PageBackground.ref, kept out of the notebook
 * JSON. They get a database of their own so adding them needed no version upgrade of "looseleaf",
 * which a tab still running an older Looseleaf would block.
 */
const ASSET_DB = "looseleaf-assets";
const ASSETS = "assets";
const BY_AGE = "createdAt";

export interface StoredAsset {
  ref: string;
  type: string;
  /** Raw bytes. An ArrayBuffer rather than a Blob: older iPadOS Safari versions were unreliable with Blobs in IndexedDB. */
  data: ArrayBuffer;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTEBOOKS)) db.createObjectStore(NOTEBOOKS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("This browser blocked local storage."));
    };
  });
  return dbPromise;
}

let assetDbPromise: Promise<IDBDatabase> | null = null;

function openAssets(): Promise<IDBDatabase> {
  if (assetDbPromise) return assetDbPromise;
  assetDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(ASSET_DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(ASSETS, { keyPath: "ref" });
      store.createIndex(BY_AGE, "createdAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      assetDbPromise = null;
      reject(req.error ?? new Error("This browser blocked local storage."));
    };
  });
  return assetDbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Storage write was aborted."));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listNotebooks(): Promise<NotebookMeta[]> {
  const db = await open();
  const all = await request(db.transaction(META).objectStore(META).getAll() as IDBRequest<NotebookMeta[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getNotebook(id: string): Promise<Notebook | null> {
  const db = await open();
  return (await request(db.transaction(NOTEBOOKS).objectStore(NOTEBOOKS).get(id) as IDBRequest<Notebook>)) ?? null;
}

export async function saveNotebook(nb: Notebook, thumb?: string): Promise<void> {
  const db = await open();
  const tx = db.transaction([NOTEBOOKS, META], "readwrite");
  tx.objectStore(NOTEBOOKS).put(nb);
  const metaStore = tx.objectStore(META);
  const prior = await request(metaStore.get(nb.id) as IDBRequest<NotebookMeta | undefined>);
  metaStore.put({
    id: nb.id,
    title: nb.title,
    cover: nb.cover,
    updatedAt: nb.updatedAt,
    pageCount: nb.pages.length,
    thumb: thumb ?? prior?.thumb,
  } satisfies NotebookMeta);
  await done(tx);
}

export async function deleteNotebook(id: string): Promise<void> {
  const db = await open();
  const doomed = await getNotebook(id);
  const tx = db.transaction([NOTEBOOKS, META], "readwrite");
  tx.objectStore(NOTEBOOKS).delete(id);
  tx.objectStore(META).delete(id);
  await done(tx);
  await collectAssets(doomed ? assetRefs(doomed) : []).catch(() => {});
}

// ---------- page background images ----------

export function assetRefs(nb: Notebook): Set<string> {
  const refs = new Set<string>();
  for (const p of nb.pages) if (p.bg) refs.add(p.bg.ref);
  return refs;
}

export async function putAsset(ref: string, blob: Blob): Promise<void> {
  const db = await openAssets();
  const data = await blob.arrayBuffer();
  const tx = db.transaction(ASSETS, "readwrite");
  tx.objectStore(ASSETS).put({ ref, type: blob.type || "image/jpeg", data, createdAt: Date.now() } satisfies StoredAsset);
  await done(tx);
}

export async function getAsset(ref: string): Promise<Blob | null> {
  const db = await openAssets();
  const hit = await request(db.transaction(ASSETS).objectStore(ASSETS).get(ref) as IDBRequest<StoredAsset | undefined>);
  return hit ? new Blob([hit.data], { type: hit.type }) : null;
}

export async function deleteAssets(refs: Iterable<string>): Promise<void> {
  const db = await openAssets();
  const tx = db.transaction(ASSETS, "readwrite");
  const store = tx.objectStore(ASSETS);
  for (const ref of refs) store.delete(ref);
  await done(tx);
}

/** Recently written images may belong to an import or an edit that has not saved its notebook yet. */
// A day: long enough that another tab's undo of a page delete, or a long import, never loses its images.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes background images no notebook uses any more. Duplicated notebooks share images, so this
 * checks every notebook rather than trusting one. `released` (the refs of a notebook just deleted)
 * go at once; other orphans (from deleted pages, say) only once they are older than a grace period.
 */
export async function collectAssets(released: Iterable<string> = []): Promise<number> {
  const db = await open();
  const all = await request(db.transaction(NOTEBOOKS).objectStore(NOTEBOOKS).getAll() as IDBRequest<Notebook[]>);
  const used = new Set<string>();
  for (const nb of all) for (const ref of assetRefs(nb)) used.add(ref);
  const now = new Set(released);
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const adb = await openAssets();
  const tx = adb.transaction(ASSETS, "readwrite");
  const finished = done(tx);
  const store = tx.objectStore(ASSETS);
  let removed = 0;
  // A key cursor over the age index reads (createdAt, ref) pairs without loading any image bytes.
  const cursor = store.index(BY_AGE).openKeyCursor();
  cursor.onsuccess = () => {
    const c = cursor.result;
    if (!c) return;
    const ref = c.primaryKey as string;
    if (!used.has(ref) && (now.has(ref) || (c.key as number) < cutoff)) {
      store.delete(ref);
      removed++;
    }
    c.continue();
  };
  await finished;
  return removed;
}

export async function countAssets(): Promise<number> {
  const db = await openAssets();
  return request(db.transaction(ASSETS).objectStore(ASSETS).count());
}

/** Ask the browser not to evict our data under storage pressure. Safe to call repeatedly. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function storageInfo(): Promise<{ used: number; quota: number; persisted: boolean } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const est = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { used: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  } catch {
    return null;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
