// Copies the files pdf.js fetches at run time (fonts, CMaps, wasm image decoders, ICC profiles) from the
// pinned pdfjs-dist package into public/pdfjs/<version>/, so they are served by this app and never by a
// CDN. Runs before `next dev` and `next build` (package.json); the output is git-ignored.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "pdfjs-dist");
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const outRoot = join(root, "public", "pdfjs");
const out = join(outRoot, version);

// Drop copies made for other versions.
if (existsSync(outRoot)) for (const name of readdirSync(outRoot)) if (name !== version) rmSync(join(outRoot, name), { recursive: true, force: true });

for (const dir of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
  const from = join(pkgDir, dir);
  if (!existsSync(from)) continue;
  mkdirSync(join(out, dir), { recursive: true });
  // quickjs-eval runs PDF JavaScript, which Looseleaf never enables; leave it out.
  cpSync(from, join(out, dir), { recursive: true, filter: (src) => !/quickjs/.test(src) });
}
console.log(`pdf.js ${version} assets copied to public/pdfjs/${version}`);
