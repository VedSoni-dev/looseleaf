// Everything lives in this browser's IndexedDB. No account, no server.
import type { Notebook, NotebookMeta } from "./types";

const DB = "looseleaf";
const NOTEBOOKS = "notebooks";
const META = "meta";

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
  const tx = db.transaction([NOTEBOOKS, META], "readwrite");
  tx.objectStore(NOTEBOOKS).delete(id);
  tx.objectStore(META).delete(id);
  await done(tx);
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
