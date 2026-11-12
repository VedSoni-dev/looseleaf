import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { PublikPitch } from "@/components/PublikGate";
import notebook from "@/public/media/01-notebook.png";
import colours from "@/public/media/02-colours.png";
import lasso from "@/public/media/03-lasso.png";
import aiOwnKey from "@/public/media/04-ai-own-key.png";
import pages from "@/public/media/05-pages.png";
import library from "@/public/media/06-library.png";
import drawing from "@/public/media/drawing.gif";

// The public landing page. No sign-in here: the app itself is at /app, behind Sign in with publik.

// Links into the app are plain <a>: a full page load gives the app its own viewport (no browser zoom) and service worker.
const APP = "/app";
const GITHUB = "https://github.com/VedSoni-dev/looseleaf";

// Links from before 0.1.4, when the app was at /: a notebook link (/#/n/<id>) and Home Screen installs that still
// open /. Both go straight on to the app. Runs while the page loads, before anything is shown.
const forwardToApp = `try{var h=location.hash;if(/^#\\/n\\//.test(h)||matchMedia("(display-mode: standalone)").matches||navigator.standalone===true)location.replace("${APP}"+h)}catch(e){}`;

// Each card shows the whole screenshot, zoomed in on the part that shows the feature (focus is the transform origin).
const features: { title: string; body: string; image: StaticImageData; alt: string; focus: string; zoom: number }[] = [
  {
    title: "Any colour you want",
    body: "Six pen colours and three thicknesses, plus a custom colour per tool from the system colour picker.",
    image: colours,
    alt: "A handwritten page with a circled word, a margin note and two highlights; the highlighter palette is open with a custom lavender selected",
    focus: "50% 100%",
    zoom: 1.6,
  },
  {
    title: "Lasso to move, copy or delete",
    body: "Circle any ink to move it, duplicate it or remove it. Or ask AI to turn it into text, explain it or solve it.",
    image: lasso,
    alt: "A lasso selection around a diagram of a leaf, with a bar offering To text, Explain, Solve, duplicate and delete",
    focus: "50% 92%",
    zoom: 1.6,
  },
  {
    title: "AI is opt-in",
    body: "Pay for AI with your publik plan, or paste your own OpenAI or Anthropic key. The key stays in your browser.",
    image: aiOwnKey,
    alt: "The Ask AI panel next to a page of notes, showing Use your own key with OpenAI and Anthropic options",
    focus: "100% 12%",
    zoom: 2,
  },
  {
    title: "Pages and paper",
    body: "Ruled, grid, dots or blank. Add pages, then export a PDF, a PNG or a portable .leaf file.",
    image: pages,
    alt: "The page menu: ruled, grid, dots or blank paper, add or clear a page, draw with finger, fit to screen, save as .leaf, export PDF or PNG",
    focus: "100% 0%",
    zoom: 2.1,
  },
  {
    title: "Your notebooks, on your device",
    body: "Unlimited notebooks and pages, saved in your browser. Nothing is uploaded, and exports have no watermark.",
    image: library,
    alt: "The notebook library with three notebooks: Biology notes, Trip ideas and Calculus",
    focus: "8% 4%",
    zoom: 1.6,
  },
];

// From the README's comparison (Goodnotes plans as listed on goodnotes.com/pricing, November 2026).
const comparison: [string, string, string][] = [
  ["Price", "Free, open source (MIT)", "Free plan; Essential $11.99/year; Pro $35.99/year; one-time Special Edition on Apple devices"],
  ["Free limits", "None: unlimited notebooks and pages", "Free plan: 3 files, 3 folders, 5 MB imports, watermarked exports"],
  ["Account", "A free publik account to open it; no Looseleaf account, notes stay in your browser", "Goodnotes account for Windows, Android and web libraries and for cloud features"],
  ["Where it runs", "Any modern browser: iPad, Mac, PC, Android tablet", "Native apps for iPad, iPhone and Mac, plus Android, Windows and web"],
  ["Handwriting", "Pressure ink, highlighter, eraser, lasso (move, copy, delete), typed text, custom colours", "All of that plus shapes, stickers, tape, elements and more"],
  ["Paper", "Ruled, grid, dots, blank", "Many paper templates and covers, plus template marketplace"],
  ["PDF import and annotation", "Not yet", "Yes"],
  ["Audio recording", "No", "Yes (20 minutes on the free plan)"],
  ["Handwriting search", "No", "Yes"],
  ["Sync and collaboration", "No cloud; move notebooks with .leaf files", "Cloud sync; real-time collaboration on Pro"],
  ["Export", "PDF, PNG, .leaf (JSON), no watermark", "PDF and more; watermark on the free plan"],
  ["AI on your notes", "Opt-in: pay-per-use via publik API, or your own OpenAI/Anthropic key", "Goodnotes AI: limited on the free plan, more with Pro or the AI Pass add-on"],
  ["Where notes live", "Only in your browser, unless you export", "On device and in Goodnotes cloud"],
];

function Logo() {
  return (
    <svg width={30} height={30} viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <rect x="15" y="10" width="34" height="44" rx="4" fill="#FFFDF8" />
      <path d="M22 37c5-11 9-11 11-3s6 6 10-7" fill="none" stroke="#1F1F1F" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OpenButton({ className = "" }: { className?: string }) {
  return (
    <a
      href={APP}
      className={`inline-flex h-12 items-center justify-center rounded-full bg-accent px-6 text-base font-semibold text-accent-ink shadow-float transition hover:brightness-110 ${className}`}
    >
      Open Looseleaf →
    </a>
  );
}

export default function Landing() {
  return (
    <div className="landing-desk min-h-full overflow-x-clip text-ink">
      <script dangerouslySetInnerHTML={{ __html: forwardToApp }} />

      <div className="mx-auto max-w-[1120px] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-8">
        <header className="flex items-center gap-3 py-3">
          <Link href="/" className="flex items-center gap-2.5 rounded-lg" aria-label="Looseleaf home">
            <Logo />
            <span className="font-serif text-xl font-semibold tracking-tight">Looseleaf</span>
          </Link>
          <div className="flex-1" />
          <a href={GITHUB} className="hidden h-10 items-center rounded-full px-3 text-sm font-medium text-muted hover:text-ink sm:flex">
            GitHub
          </a>
          <a
            href={APP}
            className="flex h-10 items-center rounded-full border border-line bg-panel px-4 text-sm font-semibold hover:bg-panel-2"
          >
            Open Looseleaf
          </a>
        </header>

        <main>
          {/* Hero */}
          <section className="pt-12 text-center sm:pt-20">
            <p className="inline-flex items-center rounded-full bg-accent px-3.5 py-1.5 text-sm font-semibold text-accent-ink">
              Free Goodnotes alternative
            </p>
            <h1 className="mx-auto mt-6 max-w-[13em] text-balance font-serif text-[clamp(2.4rem,7vw,4.6rem)] font-bold leading-[1.04] tracking-[-0.02em]">
              Handwritten notes for iPad and Apple Pencil.
            </h1>
            <p className="mx-auto mt-5 max-w-[38rem] text-[clamp(1.05rem,2.2vw,1.25rem)] leading-relaxed text-muted">
              Looseleaf is a handwriting notebook that runs in your browser. Pressure-sensitive ink, highlighter, lasso and
              unlimited notebooks, with nothing to install. Your notes stay on your device.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <OpenButton />
              <a
                href={GITHUB}
                className="inline-flex h-12 items-center rounded-full border border-line bg-panel px-5 text-base font-semibold hover:bg-panel-2"
              >
                View on GitHub
              </a>
            </div>
            <p className="mx-auto mt-4 max-w-[34rem] text-sm text-muted">
              Free and open source. Opening it asks you to sign in with a free publik account; there is no Looseleaf account.
            </p>
          </section>

          {/* The app on an iPad */}
          <figure className="mx-auto mt-12 max-w-[980px] sm:mt-16">
            <div className="rounded-[clamp(14px,3vw,34px)] bg-[#1C1B19] p-[clamp(6px,1.4vw,14px)] shadow-float ring-1 ring-line">
              <Image
                src={notebook}
                alt="Looseleaf on an iPad: a ruled page of handwritten biology notes with a highlighted word, a boxed equation and a coloured diagram, under the pen toolbar"
                sizes="(min-width: 1040px) 960px, calc(100vw - 48px)"
                loading="eager"
                fetchPriority="high"
                className="h-auto w-full rounded-[clamp(9px,2.2vw,24px)]"
              />
            </div>
            <figcaption className="mt-3 text-center text-sm text-muted">
              A full page of notes: pressure ink, highlighter, six pen colours and three thicknesses (sample notes).
            </figcaption>
          </figure>

          {/* Ink, live */}
          <section className="mt-20 grid items-center gap-8 sm:mt-28 lg:grid-cols-[5fr_7fr] lg:gap-12">
            <div>
              <h2 className="font-serif text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight tracking-tight">Ink that keeps up with your Pencil.</h2>
              <p className="mt-4 text-lg leading-relaxed text-muted">
                Pressure-sensitive strokes, palm rejection, and one-finger scroll with pinch zoom once a Pencil is detected. It
                works with a mouse or a finger too.
              </p>
              <p className="mt-3 text-lg leading-relaxed text-muted">
                Add it to your iPad Home Screen and it opens full screen, like an app.
              </p>
            </div>
            <figure>
              <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-float">
                <Image
                  src={drawing}
                  alt="Notes being handwritten into a Looseleaf page: a title, two lines, a boxed equation and a highlight"
                  unoptimized
                  className="h-auto w-full"
                />
              </div>
              <figcaption className="mt-3 text-sm text-muted">
                Ink going into the live app. Strokes are scripted pen input, sped up (sample content).
              </figcaption>
            </figure>
          </section>

          {/* Why it is free */}
          <section className="mt-20 rounded-3xl border border-line bg-panel p-6 shadow-float sm:mt-28 sm:p-10">
            <h2 className="font-serif text-[clamp(1.6rem,3.5vw,2.2rem)] font-bold leading-tight tracking-tight">Free, because of publik</h2>
            <PublikPitch
              appName="Looseleaf"
              className="mt-4 max-w-[46rem] text-lg leading-relaxed text-muted [&_.pk-pitch-cta]:mt-5 [&_.pk-pitch-cta]:inline-flex [&_.pk-pitch-cta]:font-semibold [&_.pk-pitch-cta]:text-accent [&_.pk-pitch-cta]:no-underline [&_.pk-pitch-cta:hover]:underline [&_p_a]:text-ink [&_p_a]:underline [&_p_a]:underline-offset-2"
            />
          </section>

          {/* Features */}
          <section className="mt-20 sm:mt-28" aria-labelledby="features">
            <h2 id="features" className="font-serif text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight tracking-tight">
              Everything for everyday notes
            </h2>
            <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((f) => (
                <figure key={f.title} className="flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
                  <div className="overflow-hidden border-b border-line">
                    <Image
                      src={f.image}
                      alt={f.alt}
                      sizes="(min-width: 1024px) 640px, (min-width: 640px) 90vw, 180vw"
                      className="h-auto w-full"
                      style={{ transformOrigin: f.focus, transform: `scale(${f.zoom})` }}
                    />
                  </div>
                  <figcaption className="p-5">
                    <h3 className="text-base font-semibold">{f.title}</h3>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{f.body}</p>
                  </figcaption>
                </figure>
              ))}
              <div className="flex flex-col justify-center rounded-2xl border border-line bg-accent-soft p-6">
                <p className="font-serif text-2xl font-bold leading-snug tracking-tight">No notebook limit. No watermark. Free.</p>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">Nothing to install: it runs in Safari on iPad, and in any modern browser.</p>
                <OpenButton className="mt-5 self-start" />
              </div>
            </div>
          </section>

          {/* Goodnotes, honestly */}
          <section className="mt-20 sm:mt-28" aria-labelledby="compare">
            <h2 id="compare" className="font-serif text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight tracking-tight">
              Compared with Goodnotes
            </h2>
            <p className="mt-4 max-w-[46rem] text-lg leading-relaxed text-muted">
              Goodnotes is a polished native app with years of features. Looseleaf is a small, free web app that covers
              everyday handwritten notes. Here is the honest picture.
            </p>
            <div role="table" aria-label="Looseleaf compared with Goodnotes" className="mt-8 overflow-hidden rounded-2xl border border-line bg-panel text-[15px]">
              <div role="row" className="grid grid-cols-2 gap-x-4 border-b border-line bg-panel-2 px-4 py-3 font-semibold sm:grid-cols-[minmax(0,13rem)_1fr_1fr] sm:px-6">
                <span role="columnheader" className="sr-only sm:not-sr-only">
                  <span className="sr-only">Feature</span>
                </span>
                <span role="columnheader">Looseleaf</span>
                <span role="columnheader">Goodnotes</span>
              </div>
              {comparison.map(([what, ours, theirs]) => (
                <div
                  key={what}
                  role="row"
                  className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-b border-line px-4 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,13rem)_1fr_1fr] sm:px-6"
                >
                  <span role="rowheader" className="col-span-2 font-semibold sm:col-span-1">
                    {what}
                  </span>
                  <span role="cell" className="leading-snug">{ours}</span>
                  <span role="cell" className="leading-snug text-muted">{theirs}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-sm text-muted">
              Goodnotes plans as listed on{" "}
              <a href="https://www.goodnotes.com/pricing" className="underline underline-offset-2 hover:text-ink">
                goodnotes.com/pricing
              </a>
              , November 2026.
            </p>
            <p className="mt-6 max-w-[46rem] text-lg leading-relaxed">
              If you need PDF annotation, audio or sync today, Goodnotes does more. If you want a free notebook with no limits
              that keeps your notes on your device, Looseleaf is for you.
            </p>
            <OpenButton className="mt-6" />
          </section>
        </main>

        <footer className="mt-20 flex flex-col gap-3 border-t border-line pt-8 text-sm text-muted sm:mt-28 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Looseleaf is free and open source (MIT).{" "}
            <a href={GITHUB} className="font-medium text-ink underline underline-offset-2">
              Source on GitHub
            </a>
          </p>
          <p>Not affiliated with Goodnotes.</p>
        </footer>
      </div>
    </div>
  );
}
