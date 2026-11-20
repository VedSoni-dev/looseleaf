// Browser checks for the editor, run against a local server with the publik gate and the AI stubbed
// (no publik traffic, no spend):
//
//   npm run dev -- -p 4477        (in another terminal)
//   npm run e2e                   (BASE=http://localhost:4477 by default; BROWSER=webkit for Safari's engine)
//
// Needs a Chromium that playwright-core can find (npx playwright install chromium).
import { chromium, webkit } from "playwright-core";

const BASE = process.env.BASE || "http://localhost:4477";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
};

const browser = await (process.env.BROWSER === "webkit" ? webkit : chromium).launch();

/** A fresh browser profile with the gate answered "ready" and /api/ai recorded and answered. */
async function session() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const asked = [];
  const errors = [];
  await context.route("**/api/publik/status", (r) =>
    r.fulfill({ json: { state: "ready", choice: "publik", usesAi: true, handle: "tester", telemetrySeconds: 3600 } }),
  );
  await context.route("**/api/publik/telemetry", (r) => r.fulfill({ json: { sent: false } }));
  await context.route("**/api/ai", (r) => {
    asked.push(JSON.parse(r.request().postData() ?? "{}"));
    r.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "x-looseleaf-provider": "publik" },
      body: 'data: {"choices":[{"delta":{"content":"A stubbed answer."}}]}\n\ndata: [DONE]\n\n',
    });
  });
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    return page;
  };
  return { context, asked, errors, open };
}

/** First visit lands in a fresh notebook; returns once the editor is ready. */
async function firstNotebook(page) {
  await page.goto(`${BASE}/app`);
  await page.waitForURL(/#\/n\//);
  await page.getByRole("button", { name: "Pen (P)" }).waitFor();
  await page.waitForTimeout(250);
}

async function stroke(page, points) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

const stored = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("looseleaf", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("notebooks").objectStore("notebooks").getAll();
          all.onsuccess = () => resolve(all.result);
          all.onerror = () => reject(all.error);
        };
      }),
  );
const itemCount = (nb) => nb.pages.reduce((n, p) => n + p.items.length, 0);
const jpegSize = (page, dataUrl) =>
  page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = src;
      }),
    dataUrl,
  );

// ---------- 1. drawing, saving, reload ----------
{
  const s = await session();
  const page = await s.open();
  await firstNotebook(page);
  await stroke(page, [[400, 300], [520, 340], [600, 300]]);
  await stroke(page, [[400, 420], [600, 420]]);
  await page.waitForTimeout(700);
  let [nb] = await stored(page);
  check("two strokes are saved", itemCount(nb) === 2, `${itemCount(nb)} items`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(700);
  [nb] = await stored(page);
  check("undo is saved", itemCount(nb) === 1);
  await page.reload();
  await page.getByRole("button", { name: "Pen (P)" }).waitFor();
  check("page count shows after reload", (await page.getByText("1 / 1").count()) === 1);
  check("no console errors (draw, undo, reload)", s.errors.length === 0, s.errors.join(" | "));
  await s.context.close();
}

// ---------- 2. a typed question asks about the lassoed part, not the whole page ----------
{
  const s = await session();
  const page = await s.open();
  await firstNotebook(page);
  await stroke(page, [[420, 300], [470, 330], [520, 300]]);
  await page.keyboard.press("l");
  await stroke(page, [[380, 260], [560, 260], [560, 370], [380, 370], [380, 262]]);
  await page.getByRole("button", { name: "Duplicate selection" }).waitFor();
  await page.getByRole("button", { name: "Ask AI" }).click();
  await page.getByLabel("Message").fill("What does this say?");
  await page.keyboard.press("Enter");
  await page.getByText("A stubbed answer.").waitFor();
  const size = await jpegSize(page, s.asked[0].messages[0].image);
  // The whole page is sent portrait (1224 x 1584); a lassoed squiggle is a small landscape crop.
  check("typed question with a selection sends the selection", size.w > size.h, `${size.w}x${size.h}`);
  await page.getByRole("button", { name: "New" }).click();
  await page.keyboard.press("Escape");
  await page.getByLabel("Message").fill("And the whole page?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const whole = await jpegSize(page, s.asked[1].messages[0].image);
  check("typed question without a selection sends the page", whole.h > whole.w, `${whole.w}x${whole.h}`);
  check("no console errors (AI)", s.errors.length === 0, s.errors.join(" | "));
  await s.context.close();
}

// ---------- 3. a file dropped on the editor never navigates the tab away; a PDF is added ----------
{
  const s = await session();
  const page = await s.open();
  await firstNotebook(page);
  const drop = (name, type, text) =>
    page.evaluate(
      ([name, type, text]) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], name, { type }));
        const target = document.elementFromPoint(640, 450);
        const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
        target.dispatchEvent(over);
        const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
        target.dispatchEvent(drop);
        return over.defaultPrevented && drop.defaultPrevented;
      },
      [name, type, text],
    );
  check("editor: a dropped file is handled, not opened by the browser", await drop("notes.txt", "text/plain", "not a pdf"));
  check("editor: a dropped non-PDF says what to drop", (await page.getByText("Drop a PDF to add its pages here.").count()) === 1);
  const pdf =
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
  await drop("slides.pdf", "application/pdf", pdf);
  await page.getByText("1 / 2").or(page.getByText("2 / 2")).waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(700);
  const [nb] = await stored(page);
  check("editor: a dropped PDF adds its pages", nb.pages.length === 2 && !!nb.pages[1].bg, `${nb.pages.length} pages`);
  check("editor: no console errors (drop)", s.errors.length === 0, s.errors.join(" | "));
  await s.context.close();
}

// ---------- 4. undo in the middle of a stroke does not crash ----------
{
  const s = await session();
  const page = await s.open();
  await firstNotebook(page);
  await page.getByRole("button", { name: "Add page" }).click();
  await page.waitForTimeout(300);
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(600, 450, { steps: 5 });
  await page.keyboard.press("Control+z"); // takes the page being drawn on away
  await page.mouse.move(650, 470, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("undo mid-stroke: no error", s.errors.length === 0, s.errors.join(" | "));
  await stroke(page, [[400, 300], [600, 320]]);
  await page.waitForTimeout(700);
  const [nb] = await stored(page);
  check("undo mid-stroke: still drawing afterwards", itemCount(nb) >= 1, `${itemCount(nb)} items`);
  await s.context.close();
}

// ---------- 5. the same notebook in two tabs ----------
{
  const s = await session();
  const a = await s.open();
  await firstNotebook(a);
  const url = a.url();
  const id = url.split("/n/")[1];
  const ys = (nb) => nb.pages.flatMap((p) => p.items.map((it) => Math.round(it.pts[1])));
  await stroke(a, [[400, 300], [600, 300]]);
  await a.waitForTimeout(700);

  // Tab B opens the notebook and adds two strokes while A sits in the background.
  const b = await s.open();
  await b.goto(url);
  await b.getByRole("button", { name: "Pen (P)" }).waitFor();
  await b.waitForTimeout(250);
  await stroke(b, [[400, 400], [600, 400]]);
  await stroke(b, [[400, 500], [600, 500]]);
  await b.waitForTimeout(700);
  let all = await stored(b);
  check("two tabs: B's strokes are saved", all.length === 1 && itemCount(all[0]) === 3, `${itemCount(all[0])} items`);

  // Back to the stale tab A: it picks up B's work, and one more stroke adds to it.
  await a.bringToFront();
  await a.evaluate(() => window.dispatchEvent(new Event("focus")));
  await a.getByText("Updated with changes from another tab.").waitFor({ timeout: 3000 }).catch(() => {});
  await stroke(a, [[400, 600], [600, 600]]);
  await a.waitForTimeout(900);
  all = await stored(a);
  check("two tabs: a stale tab picks up the other tab's work", all.length === 1 && itemCount(all[0]) === 4, `${all.length} notebooks, main has ${itemCount(all.find((nb) => nb.id === id))} items`);

  // B never got a focus event, so it is stale now. Writing in it must not lose A's last stroke.
  await stroke(b, [[400, 650], [600, 650]]);
  await b.waitForTimeout(900);
  all = await stored(b);
  const seen = new Set(all.flatMap(ys));
  check("two tabs: writing in a stale tab loses nothing", seen.size === 5 /* strokes drawn so far */, `${all.map((nb) => `${nb.title}: ${itemCount(nb)}`).join("; ")}`);
  const copies = all.filter((nb) => nb.id !== id);
  check("two tabs: the other tab's version is kept as one copy", copies.length === 1 && copies[0].title.startsWith("Other tab's copy: ") && itemCount(copies[0]) === 4, `${copies.length} copies`);
  check("two tabs: the tab says so", (await b.getByText("That tab's version is kept as a copy.", { exact: false }).count()) === 1);
  await stroke(b, [[400, 700], [600, 700]]);
  await b.waitForTimeout(900);
  all = await stored(b);
  check("two tabs: copies do not pile up", all.length === 2, `${all.length} notebooks`);
  check("two tabs: no console errors", s.errors.length === 0, s.errors.join(" | "));
  await s.context.close();
}

// ---------- 6. library: Escape cancels a rename; the drop overlay goes away ----------
{
  const s = await session();
  const page = await s.open();
  await firstNotebook(page);
  await page.getByRole("button", { name: "Back to notebooks" }).click();
  await page.getByRole("button", { name: /^Options for/ }).click();
  await page.getByRole("button", { name: "Rename" }).click();
  await page.keyboard.type("Should not stick");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const [nb] = await stored(page);
  check("library: Escape cancels a rename", nb.title === "Untitled notebook", nb.title);

  const stuck = await page.evaluate(async () => {
    const main = document.querySelector("main");
    const child = main.querySelector("h1");
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "a.leaf"));
    child.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    child.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 100));
    const shown = document.body.innerText.includes("Drop a PDF or .leaf to open");
    // The pointer leaves the window while over a child element.
    child.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: null }));
    await new Promise((r) => setTimeout(r, 300));
    return { shown, after: document.body.innerText.includes("Drop a PDF or .leaf to open") };
  });
  check("library: the drop overlay goes away when the drag leaves the window", stuck.shown && !stuck.after, JSON.stringify(stuck));
  check("library: no console errors", s.errors.length === 0, s.errors.join(" | "));
  await s.context.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
