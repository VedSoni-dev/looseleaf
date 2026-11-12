import type { Metadata, Viewport } from "next";
import "./globals.css";

const title = "Looseleaf — handwritten notes, free, in your browser";
const description =
  "A free handwriting notebook for iPad and Apple Pencil that runs in the browser. Unlimited notebooks, portable .leaf files, notes that stay on your device, and AI that reads your handwriting.";

export const metadata: Metadata = {
  metadataBase: new URL("https://looseleaf-seven-green.vercel.app"),
  title,
  description,
  applicationName: "Looseleaf",
  appleWebApp: { capable: true, title: "Looseleaf", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  openGraph: { type: "website", siteName: "Looseleaf", title, description, url: "/" },
  twitter: { card: "summary_large_image", title, description },
};

// The landing page can be zoomed; app/app/page.tsx turns zoom off for the drawing surface.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ECE9E2" },
    { media: "(prefers-color-scheme: dark)", color: "#151513" },
  ],
};

// No sign-in here: the public landing page is at /, and only the app at /app is behind Sign in with publik.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
