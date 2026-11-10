import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ship the public publik app token with the server functions that read it.
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
