import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // id stays "/" (what start_url "/" gave before 0.1.4), so existing installs are updated rather than duplicated.
    id: "/",
    name: "Looseleaf",
    short_name: "Looseleaf",
    description: "Handwritten notes in your browser. Free.",
    // The app is at /app; the public landing page is at /. The scope covers both, so an older install that still
    // opens / stays in its window and the landing page forwards it to /app.
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ECE9E2",
    theme_color: "#ECE9E2",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
