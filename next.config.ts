import { existsSync, readFileSync } from "node:fs";
import type { NextConfig } from "next";

// The publik app token is public by design. lib/publik.ts reads publik-app-token.txt at run time
// (shipped with the server routes below); the copy inlined here is its fallback, so every server
// function has it whichever files the host traces into each function.
const appToken = existsSync("./publik-app-token.txt") ? readFileSync("./publik-app-token.txt", "utf8").trim() : "";

const nextConfig: NextConfig = {
  env: { LOOSELEAF_APP_TOKEN: appToken },
  outputFileTracingIncludes: { "/api/**": ["./publik-app-token.txt"] },
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
