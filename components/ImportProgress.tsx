"use client";

import { useEffect, useRef } from "react";

export interface ImportState {
  name: string;
  done: number;
  total: number;
}

/** Modal progress for a PDF import: "Importing page 12 of 48", with a Cancel that stops it and cleans up. */
export default function ImportProgress({ state, onCancel }: { state: ImportState; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
  const label = state.total ? `Importing page ${Math.min(state.done + 1, state.total)} of ${state.total}` : "Opening PDF";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <div className="rise w-full max-w-sm rounded-3xl border border-line bg-panel p-6 shadow-float">
        <p id="import-title" className="truncate font-serif text-xl font-semibold">
          {state.name}
        </p>
        <p role="status" aria-live="polite" className="mt-1 text-sm tabular-nums text-muted">
          {label}…
        </p>
        <div
          className="mt-4 h-2 overflow-hidden rounded-full bg-panel-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Import progress"
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">Pages are prepared on this device; nothing is uploaded.</p>
        <div className="mt-5 flex justify-end">
          <button ref={cancel} onClick={onCancel} className="h-10 rounded-full border border-line px-4 text-sm font-medium hover:bg-panel-2">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
