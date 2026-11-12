import type { Viewport } from "next";
import App from "@/components/App";
import { PublikGate } from "@/components/PublikGate";

// The software lives here, behind Sign in with publik. The landing page at / is public.
// The drawing surface handles pinch zoom itself, so the browser must not zoom this page.
export const viewport: Viewport = { maximumScale: 1, userScalable: false };

export default function AppPage() {
  return (
    <PublikGate appName="Looseleaf">
      <App />
    </PublikGate>
  );
}
