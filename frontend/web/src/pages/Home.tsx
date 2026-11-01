/**
 * Home: the open-source landing page — what the desktop app does, that it is free and runs locally, the free online
 * recorders, and the downloads. Download / source links come from REPO_URL (src/config.ts); while it is unset a short
 * note stands in for them, so the page never shows a dead link.
 */
import { Camera, Captions, Code, Download, Film, Highlighter, Mic, Monitor, MousePointerClick, RectangleVertical, Scissors, ShieldCheck, Webcam, ZoomIn } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { AppLink, SiteFooter, SiteNav } from '../components/SiteChrome';
import { PRODUCT, REPO } from '../config';

const FEATURES: ReadonlyArray<{ icon: ReactNode; title: string; text: string }> = [
  { icon: <ZoomIn />, title: 'Automatic zoom', text: 'Every click and typing burst gets a smooth zoom that follows your cursor. Adjust or split any zoom, or switch it to 3D motion.' },
  { icon: <MousePointerClick />, title: 'Cursor effects', text: 'A smoothed cursor path, 40 cursor styles, click effects and click sounds — or hide the cursor while it’s idle.' },
  { icon: <Webcam />, title: 'Camera layouts', text: 'Corner, side-by-side and camera-only layouts with animated switches, plus background blur or removal — no green screen.' },
  { icon: <Captions />, title: 'Local captions', text: 'Captions are transcribed on your computer with Whisper (whisper.cpp). Edit them, pick a style, export SRT or VTT.' },
  { icon: <Scissors />, title: 'Smart Cut', text: 'Finds pauses and filler words in the transcript so you can remove them in one go — and restore them just as easily.' },
  { icon: <Highlighter />, title: 'Annotations', text: 'Text, arrows, shapes and highlights, plus blur, spotlight and magnifier masks that stay on the content while zooming.' },
  { icon: <RectangleVertical />, title: 'Social-platform presets', text: 'YouTube, YouTube Shorts, Instagram Reels, TikTok, LinkedIn, X and Facebook — with safe-zone guides for each app.' },
  { icon: <Film />, title: 'MP4 & GIF up to 4K60', text: 'Export MP4 up to 4K at 60 fps, or a GIF, and keep your favorite export settings as the default.' },
];

const PRINCIPLES: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'Free and open source', text: 'Every feature is included: no plans, no credits, no forced watermark. Read the code, build it yourself, improve it.' },
  { title: 'Runs on your computer', text: 'Recording, editing, captions, vocal enhancement and export all happen locally. Your recordings are never uploaded.' },
  { title: 'No account, no telemetry', text: 'Install it and press record. Nothing to sign in to, and no usage data or analytics are collected.' },
];

const TOOLS = [
  { to: '/tools/screen-recorder', icon: <Monitor />, title: 'Free online screen recorder', text: 'Screen + camera + mic, right in your browser.' },
  { to: '/tools/camera-recorder', icon: <Camera />, title: 'Online camera recorder', text: 'Record your webcam — saved locally.' },
  { to: '/tools/mic-recorder', icon: <Mic />, title: 'Online mic recorder', text: 'Quick voice recordings, no sign-up.' },
] as const;

const primaryBtn = 'inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent/85';
const secondaryBtn = 'inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-sm font-semibold transition hover:border-accent';

/** Scrolls to the element the URL hash names (/#download): on direct loads, links from other pages and in-page links. */
function useHashScroll(): void {
  useEffect(() => {
    const scroll = () => {
      const id = location.hash.slice(1);
      if (id) document.getElementById(id)?.scrollIntoView();
    };
    scroll();
    window.addEventListener('popstate', scroll);
    return () => window.removeEventListener('popstate', scroll);
  }, []);
}

export default function Home() {
  useHashScroll();
  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <SiteNav className="mb-16" />

      <header>
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-xs text-muted"><Code size={14} className="text-accent-2" />Free and open source · Windows and macOS</p>
        <h1 className="mt-5 text-4xl font-bold leading-tight sm:text-5xl">Record once.<br /><span className="text-accent-2">Get a polished video automatically.</span></h1>
        <p className="mt-4 max-w-2xl text-muted">{PRODUCT} is an auto-zoom screen recorder: it zooms in on every click, smooths your cursor, lays out your camera, writes captions and finds the pauses to cut — then exports MP4 or GIF up to 4K 60 fps. It runs on your computer, so nothing is uploaded, and there’s no account to create.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <AppLink to="/#download" className={primaryBtn}><Download size={16} />Download</AppLink>
          <AppLink to="/tools/screen-recorder" className={secondaryBtn}><Monitor size={16} />Try it in your browser</AppLink>
        </div>
      </header>

      <section aria-labelledby="features-h" className="mt-20">
        <h2 id="features-h" className="text-2xl font-bold">Everything a good screen recording needs</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-2xl border border-line bg-panel p-5">
              <div className="mb-3 text-accent-2" aria-hidden="true">{f.icon}</div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-muted">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="local-h" className="mt-16 rounded-2xl border border-accent/40 bg-accent/10 p-6">
        <h2 id="local-h" className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck size={20} className="text-accent-2" />Yours, on your computer</h2>
        <div className="mt-4 grid gap-5 sm:grid-cols-3">
          {PRINCIPLES.map((p) => (
            <div key={p.title}>
              <h3 className="text-sm font-semibold">{p.title}</h3>
              <p className="mt-1 text-sm text-muted">{p.text}</p>
            </div>
          ))}
        </div>
        <AppLink to="/docs#privacy" className="mt-5 inline-block text-sm text-accent-2 underline decoration-accent-2/40 underline-offset-2 hover:decoration-accent-2">How your privacy is protected</AppLink>
      </section>

      <section aria-labelledby="online-h" className="mt-16">
        <h2 id="online-h" className="text-2xl font-bold">No install? Record in your browser</h2>
        <p className="mt-2 text-sm text-muted">Quick recordings without the desktop app — processed in your browser, never uploaded.</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {TOOLS.map((c) => (
            <AppLink key={c.to} to={c.to} className="rounded-2xl border border-line bg-panel p-5 transition hover:border-accent">
              <div className="mb-3 text-accent-2" aria-hidden="true">{c.icon}</div>
              <div className="font-semibold">{c.title}</div>
              <div className="mt-1 text-sm text-muted">{c.text}</div>
            </AppLink>
          ))}
        </div>
      </section>

      <section id="download" aria-labelledby="download-h" className="mt-16 scroll-mt-8 rounded-2xl border border-line bg-panel p-6">
        <h2 id="download-h" className="text-2xl font-bold">Download</h2>
        <p className="mt-2 text-sm text-muted">For Windows (64-bit) and macOS (Apple silicon and Intel). Free, with no account or sign-in.</p>
        {REPO ? (
          <>
            <div className="mt-5 flex flex-wrap gap-3">
              <a href={REPO.releases} className={primaryBtn}><Download size={16} />Windows installer (.exe)</a>
              <a href={REPO.releases} className={primaryBtn}><Download size={16} />macOS (.dmg)</a>
              <a href={REPO.source} className={secondaryBtn}><Code size={16} />Build from source</a>
            </div>
            <p className="mt-4 text-xs text-muted">The download buttons open the latest release on GitHub — pick the .exe (Windows) or .dmg (macOS) file under Assets.</p>
          </>
        ) : (
          <p className="mt-5 rounded-lg border border-line bg-bg p-4 text-sm text-muted">Download links appear here once the project is published on GitHub.</p>
        )}
      </section>

      <SiteFooter />
    </div>
  );
}
