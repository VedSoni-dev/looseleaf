import { existsSync, readFileSync } from "node:fs";
import type { NextConfig } from "next";

// The publik app token is public by design. Inlining it at build time means every server
// function has it, without depending on which files the host traces into each function.
const appToken = existsSync("./publik-app-token.txt") ? readFileSync("./publik-app-token.txt", "utf8").trim() : "";

const nextConfig: NextConfig = {
  env: { LOOSELEAF_APP_TOKEN: appToken },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
