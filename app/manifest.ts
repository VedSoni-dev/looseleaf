import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Looseleaf",
    short_name: "Looseleaf",
    description: "Handwritten notes in your browser. Free, no sign-up.",
    start_url: "/",
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
