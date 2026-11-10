"use client";

import { useEffect, useSyncExternalStore } from "react";
import Editor from "./Editor";
import Library from "./Library";
import { requestPersistence } from "@/lib/store";

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function openNotebook(id: string) {
  window.location.hash = `#/n/${id}`;
}

export function goHome() {
  window.location.hash = "";
}

export default function App() {
  // null on the server and during hydration, so nothing that needs IndexedDB renders too early.
  const hash = useSyncExternalStore<string | null>(
    subscribe,
    () => window.location.hash,
    () => null,
  );

  useEffect(() => {
    requestPersistence();
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        // Hand the worker everything this visit already loaded, so one visit is enough to work offline.
        const urls = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => name.startsWith(window.location.origin + "/_next/static/"));
        registration.active?.postMessage({ type: "precache", urls });
      })
      .catch(() => {});
  }, []);

  if (hash === null) return <div className="h-full bg-desk" />;
  const match = hash.match(/^#\/n\/([\w-]+)/);
  if (match) return <Editor key={match[1]} id={match[1]} onExit={goHome} />;
  return <Library />;
}
