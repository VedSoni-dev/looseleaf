// Same-origin check tests (ported from Linework). Run: npm test  (Node 23+ reads the .ts file directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { foreignOrigin } from "../lib/origin.ts";

const r = (h, url = "https://looseleaf-seven-green.vercel.app/api/ai") => new Request(url, { method: "POST", headers: h });

test("same origin passes", () => {
  assert.equal(foreignOrigin(r({ origin: "https://looseleaf-seven-green.vercel.app", host: "looseleaf-seven-green.vercel.app", "sec-fetch-site": "same-origin" })), false);
  assert.equal(foreignOrigin(r({ origin: "http://localhost:3000", host: "localhost:3000" }, "http://localhost:3000/api/ai")), false);
});
test("x-forwarded-host wins over host", () => {
  assert.equal(foreignOrigin(r({ origin: "https://looseleaf-seven-green.vercel.app", host: "internal", "x-forwarded-host": "looseleaf-seven-green.vercel.app" })), false);
});
test("no Origin and no Sec-Fetch-Site passes (curl carries no cookies)", () => {
  assert.equal(foreignOrigin(r({ host: "looseleaf-seven-green.vercel.app" })), false);
});
test("another site is refused", () => {
  assert.equal(foreignOrigin(r({ origin: "https://evil.example", host: "looseleaf-seven-green.vercel.app" })), true);
  assert.equal(foreignOrigin(r({ "sec-fetch-site": "cross-site", host: "looseleaf-seven-green.vercel.app" })), true);
  assert.equal(foreignOrigin(r({ "sec-fetch-site": "same-site", origin: "https://other.vercel.app", host: "looseleaf-seven-green.vercel.app" })), true);
});
test("opaque and malformed origins are refused", () => {
  assert.equal(foreignOrigin(r({ origin: "null", host: "looseleaf-seven-green.vercel.app" })), true);
  assert.equal(foreignOrigin(r({ origin: "::", host: "looseleaf-seven-green.vercel.app" })), true);
});
test("a port mismatch is refused", () => {
  assert.equal(foreignOrigin(r({ origin: "http://localhost:4000", host: "localhost:3000" }, "http://localhost:3000/api/ai")), true);
});
