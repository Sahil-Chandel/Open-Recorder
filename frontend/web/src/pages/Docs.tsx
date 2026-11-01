/** Docs / guide (task 14.8): user guides mirroring the feature set, privacy, FAQ, changelog and public roadmap. */
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SiteFooter } from '../components/SiteChrome';
import { PRODUCT } from '../config';
import { CHANGELOG, CHANGELOG_ID, GUIDES, ROADMAP, SHIPPED, sectionFromHash } from '../docs/content';
import { navigate } from '../main';

/** Sidebar entries: every guide, then the combined changelog & roadmap. */
const SECTIONS: ReadonlyArray<{ id: string; title: string }> = [...GUIDES.map(({ id, title }) => ({ id, title })), { id: CHANGELOG_ID, title: 'Changelog & roadmap' }];

export default function Docs() {
  const [open, setOpen] = useState(() => sectionFromHash(location.hash));
  // Follow /docs#<section> links (footer, home page, back / forward), starting each section at the top.
  useEffect(() => {
    const sync = () => {
      setOpen(sectionFromHash(location.hash));
      if (location.hash) window.scrollTo(0, 0);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const select = (id: string) => {
    setOpen(id);
    history.replaceState(null, '', `#${id}`);
  };
  const g = GUIDES.find((x) => x.id === open) ?? GUIDES[0]!;
  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex flex-col gap-8 md:flex-row">
        {/* Phones: wrapped chips above the article; md+: the vertical sidebar. */}
        <nav aria-label="Guide" className="flex flex-wrap gap-1 text-sm md:block md:w-52 md:shrink-0 md:space-y-1">
          <button onClick={() => navigate('/')} className="mb-3 basis-full text-left text-muted md:mb-4">← {PRODUCT}</button>
          {SECTIONS.map((x) => (
            <button key={x.id} onClick={() => select(x.id)} aria-current={open === x.id ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-left md:block md:w-full ${open === x.id ? 'bg-accent/20 text-accent-2' : 'text-muted hover:text-text'}`}>{x.title}</button>
          ))}
        </nav>
        <article className="min-w-0 flex-1 space-y-4 text-sm leading-relaxed">
          {open === CHANGELOG_ID ? (
            <>
              <h1 className="text-2xl font-bold">Changelog</h1>
              {CHANGELOG.map((c) => <div key={c.v}><div className="font-semibold">{c.v} · {c.date}</div><ul className="list-disc pl-5 text-muted">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul></div>)}
              <h2 className="pt-4 text-xl font-bold">Roadmap</h2>
              <h3 className="font-semibold">Shipped</h3>
              <ul className="space-y-1 text-muted">{SHIPPED.map((r) => <li key={r} className="flex items-center gap-2"><Check size={14} className="shrink-0 text-accent-2" />{r}</li>)}</ul>
              <h3 className="font-semibold">Planned</h3>
              <ul className="list-disc pl-5 text-muted">{ROADMAP.map((r) => <li key={r}>{r}</li>)}</ul>
            </>
          ) : (
            <>
              <h1 className="text-2xl font-bold">{g.title}</h1>
              {g.body.map((p) => <p key={p} className="text-muted">{p}</p>)}
            </>
          )}
        </article>
      </div>
      <SiteFooter />
    </div>
  );
}
