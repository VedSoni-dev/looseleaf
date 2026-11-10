# Looseleaf

A free handwriting notebook that runs in the browser. Built for iPad and Apple Pencil, works with a mouse or finger too. A free alternative to Goodnotes.

- **No sign-up.** Open it and write. Notebooks are saved in your browser (IndexedDB).
- **Unlimited notebooks and pages**, no watermark on exports.
- **Portable `.leaf` files.** Export a notebook, open it on any other device. The format is plain JSON (see below).
- **Pencil-first input.** Pressure-sensitive ink, palm rejection, one-finger scroll and pinch zoom once a Pencil is detected.
- **AI that reads your handwriting.** Lasso some ink and convert it to text, have it explained, or get a maths problem solved. Ask questions about a whole page, make flashcards, get quizzed.
- **Works offline** after the first visit (AI needs a connection). Add it to the iPad Home Screen for a full-screen app.

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
