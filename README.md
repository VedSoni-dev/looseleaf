<p align="center">
  <img src="docs/media/cover.png" alt="Looseleaf: handwritten notes for iPad and Apple Pencil, in your browser. A free Goodnotes alternative." width="100%">
</p>

# Looseleaf

**Handwritten notes for iPad and Apple Pencil, right in the browser. Free, no account, no notebook limit.**

**[Open Looseleaf](https://looseleaf-seven-green.vercel.app)** · nothing to install · MIT licensed · a free alternative to Goodnotes

<p align="center">
  <img src="docs/media/drawing.gif" alt="Notes being handwritten into a Looseleaf page: a title, two lines, a boxed equation and a highlight" width="760">
</p>
<p align="center"><sub>Ink going into the live app. Strokes are scripted pen input, sped up. All notebook content shown here is sample content.</sub></p>

<table>
  <tr>
    <td width="50%"><img src="docs/media/01-notebook.png" alt="A ruled page of handwritten biology notes with a highlighted word, a boxed equation and a coloured diagram"><br><sub><b>A full page of notes.</b> Pressure ink, highlighter, six pen colours and three thicknesses (sample notes).</sub></td>
    <td width="50%"><img src="docs/media/02-colours.png" alt="The same page with a circled word, a margin note and two highlights; the highlighter palette is open with a custom lavender selected"><br><sub><b>Any colour you want.</b> Presets plus a custom colour per tool, picked with the system colour picker.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/03-lasso.png" alt="A lasso selection around the diagram with a bar offering To text, Explain, Solve, duplicate and delete"><br><sub><b>Lasso to move, copy or delete.</b> Or ask AI to turn the selection into text, explain it or solve it.</sub></td>
    <td><img src="docs/media/04-ai.png" alt="The Ask AI panel showing the Turn on AI card with a Use my own key button"><br><sub><b>AI is opt-in.</b> Turn it on with publik API, or paste your own OpenAI or Anthropic key. Shown before any request is made.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/media/05-pages.png" alt="The page menu: ruled, grid, dots or blank paper, add or clear a page, draw with finger, fit to screen, save as .leaf, export PDF or PNG"><br><sub><b>Pages and paper.</b> Ruled, grid, dots or blank; add pages; export PDF, PNG or a portable <code>.leaf</code> file.</sub></td>
    <td><img src="docs/media/06-library.png" alt="The notebook library with three notebooks: Biology notes, Trip ideas and Calculus"><br><sub><b>Your notebooks, in your browser.</b> No sign-up; everything is stored on the device (sample notebooks).</sub></td>
  </tr>
</table>

## What you get

- **No sign-up.** Open it and write. Notebooks are saved in your browser (IndexedDB).
- **Unlimited notebooks and pages**, no watermark on exports.
- **Portable `.leaf` files.** Export a notebook, open it on any other device. The format is plain JSON (see below).
- **Pencil-first input.** Pressure-sensitive ink, palm rejection, one-finger scroll and pinch zoom once a Pencil is detected. Works with a mouse or finger too. (This is v0.1: the Pencil handling has not had a tuning pass on a real iPad yet, so issues are very welcome.)
- **AI that reads your handwriting.** Lasso some ink and convert it to text, have it explained, or get a maths problem solved. Ask questions about a whole page, make flashcards, get quizzed.
- **Works offline** after the first visit (AI needs a connection). Add it to the iPad Home Screen for a full-screen app.

## Compared with Goodnotes

Goodnotes is a polished native app with years of features. Looseleaf is a small, free web app that covers everyday handwritten notes. Here is the honest picture (Goodnotes plans as listed on [goodnotes.com/pricing](https://www.goodnotes.com/pricing), November 2026):

| | Looseleaf | Goodnotes |
|---|---|---|
| Price | Free, open source (MIT) | Free plan; Essential $11.99/year; Pro $35.99/year; one-time Special Edition on Apple devices |
| Free limits | None: unlimited notebooks and pages | Free plan: 3 files, 3 folders, 5 MB imports, watermarked exports |
| Account | None | Goodnotes account for Windows, Android and web libraries and for cloud features |
| Where it runs | Any modern browser: iPad, Mac, PC, Android tablet | Native apps for iPad, iPhone and Mac, plus Android, Windows and web |
| Handwriting | Pressure ink, highlighter, eraser, lasso (move, copy, delete), typed text, custom colours | All of that plus shapes, stickers, tape, elements and more |
| Paper | Ruled, grid, dots, blank | Many paper templates and covers, plus template marketplace |
| PDF import and annotation | Not yet | Yes |
| Audio recording | No | Yes (20 minutes on the free plan) |
| Handwriting search | No | Yes |
| Sync and collaboration | No cloud; move notebooks with `.leaf` files | Cloud sync; real-time collaboration on Pro |
| Export | PDF, PNG, `.leaf` (JSON), no watermark | PDF and more; watermark on the free plan |
| AI on your notes | Opt-in: pay-per-use via publik API, or your own OpenAI/Anthropic key | Goodnotes AI: limited on the free plan, more with Pro or the AI Pass add-on |
| Where notes live | Only in your browser, unless you export | On device and in Goodnotes cloud |

If you need PDF annotation, audio or sync today, Goodnotes does more. If you want a free notebook with no limits and no account, Looseleaf is for you.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000. For a production build: `npm run build && npm start`.

## AI

AI features go through [publik API](https://publikhq.com/developers), so users need no key: they press "Turn on AI", and linking a publik account gives a little free use. Anyone can instead paste their own OpenAI or Anthropic **API key** under the key icon in the AI panel; it is stored only in that browser. ChatGPT and Claude subscriptions are not API keys and cannot be used.

Server environment variables (all optional):

| Name | Purpose |
|---|---|
| `PUBLIK_APP_TOKEN` | The app's public publik token. Overrides `publik-app-token.txt`. |
| `PUBLIK_API_KEY` | Use one fixed publik key for every request (handy for local testing). |
| `PUBLIK_API_BASE_URL` | Override the publik API base URL. |
| `LOOSELEAF_HOSTED` | Set to `1` when you host this for other people anywhere but Vercel, so each visitor gets their own publik install (kept in a cookie) instead of sharing the server's. |

What is sent: only the page image (or the lassoed part) and your question, and only when you ask. Notes are never uploaded otherwise.

## The `.leaf` format

A `.leaf` file is one JSON object:

```jsonc
{
  "format": "looseleaf",
  "version": 1,
  "id": "…", "title": "Physics", "cover": "#2F7D4F",
  "createdAt": 1794300000000, "updatedAt": 1794300000000,
  "pages": [
    {
      "id": "…",
      "paper": "ruled",            // blank | ruled | grid | dots
      "items": [
        // pts is a flat list of x, y, pressure triples; a page is 816 × 1056 units
        { "id": "…", "type": "stroke", "tool": "pen", "color": "#1F1F1F", "size": 4, "real": true, "pts": [120, 200, 0.4, 121.5, 201, 0.5] },
        { "id": "…", "type": "text", "x": 100, "y": 300, "w": 420, "size": 18, "color": "#1F1F1F", "text": "Typed text" }
      ]
    }
  ]
}
```

Readers should skip item types they do not know.

## Shortcuts

`P` pen · `H` highlighter · `E` eraser · `L` lasso · `T` text · `⌘Z` / `⇧⌘Z` undo and redo · `⌘D` duplicate selection · `Delete` remove selection · hold `Space` and drag to pan · `⌘`/`Ctrl` + scroll to zoom.

## Not in this version

PDF import and annotation, audio recording, real-time collaboration, handwriting search, shape snapping, accounts and cloud sync.

## Stack

Next.js (App Router), TypeScript, Tailwind, [perfect-freehand](https://github.com/steveruizok/perfect-freehand) for stroke geometry, jsPDF for PDF export.

MIT licensed.
