import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PublikGate } from "@/components/PublikGate";

export const metadata: Metadata = {
  title: "Looseleaf — handwritten notes, free, in your browser",
  description:
    "A free handwriting notebook for iPad and Apple Pencil that runs in the browser. No sign-up, unlimited notebooks, portable .leaf files, and AI that reads your handwriting.",
  applicationName: "Looseleaf",
  appleWebApp: { capable: true, title: "Looseleaf", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ECE9E2" },
    { media: "(prefers-color-scheme: dark)", color: "#151513" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">
        <PublikGate appName="Looseleaf">{children}</PublikGate>
      </body>
    </html>
  );
}
