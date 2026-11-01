/**
 * Server-render smoke tests for every page: content renders without a browser, and every link points at a page or
 * section that exists — repository links only when VITE_REPO_URL is set, and never a dead one.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sectionFromHash } from '../docs/content';

vi.mock('../main', () => ({ navigate: vi.fn() }));

type Page = 'home' | 'docs' | 'screen' | 'camera' | 'mic';
const PAGES: readonly Page[] = ['home', 'docs', 'screen', 'camera', 'mic'];
const REPO = 'https://github.com/example/recorder';

const at = (pathname: string, hash = '') => vi.stubGlobal('location', { pathname, hash, search: '', href: `https://recorder.test${pathname}${hash}` });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Renders a page against a fresh module graph, so src/config.ts re-reads VITE_REPO_URL. */
async function render(page: Page, { repo, hash = '' }: { repo?: string | undefined; hash?: string } = {}): Promise<string> {
  vi.stubEnv('VITE_REPO_URL', repo);
  vi.resetModules();
  if (page === 'home') {
    at('/', hash);
    const { default: Home } = await import('./Home');
    return renderToStaticMarkup(<Home />);
  }
  if (page === 'docs') {
    at('/docs', hash);
    const { default: Docs } = await import('./Docs');
    return renderToStaticMarkup(<Docs />);
  }
  at(`/tools/${page}-recorder`);
  const { default: Tools } = await import('../tools/Tools');
  return renderToStaticMarkup(<Tools mode={page} />);
}

interface Link { href: string; text: string }
const links = (html: string): Link[] =>
  [...html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1]!.replace(/&amp;/g, '&'), text: m[2]!.replace(/<[^>]+>/g, '').trim() }));
const ids = (html: string): Set<string> => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));

/** Mirrors the router in main.tsx (unknown paths fall back to Home, so a link to one would be a dead link). */
function isLiveInternal(href: string, homeIds: Set<string>): boolean {
  const [path, hash] = href.split('#', 2) as [string, string | undefined];
  if (path === '/docs') return hash === undefined || sectionFromHash(hash) === hash;
  if (path === '/') return hash === undefined || homeIds.has(hash);
  return hash === undefined && /^\/tools\/(screen|camera|mic)-recorder$/.test(path);
}

describe('without VITE_REPO_URL', () => {
  it.each(PAGES)('%s links only to pages and sections that exist', async (page) => {
    const homeIds = ids(await render('home'));
    const all = links(await render(page));
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) expect(isLiveInternal(l.href, homeIds), `${page}: ${l.text} → "${l.href}"`).toBe(true);
  });

  it('home shows a note instead of download buttons', async () => {
    const html = await render('home');
    expect(html).toContain('id="download"');
    expect(html).toContain('Download links appear here once the project is published on GitHub.');
    expect(html).not.toContain('Windows installer (.exe)');
    expect(html).not.toContain('macOS (.dmg)');
    expect(html).not.toContain('Build from source');
  });

  it('home presents the free, open-source, local app and its features', async () => {
    const html = await render('home');
    for (const text of ['Free and open source', 'nothing is uploaded', 'No account, no telemetry', 'Automatic zoom', 'Cursor effects', 'Camera layouts', 'Whisper (whisper.cpp)', 'Smart Cut', 'Annotations', 'YouTube Shorts', 'Instagram Reels', 'LinkedIn', 'Export MP4 up to 4K at 60 fps, or a GIF']) {
      expect(html).toContain(text);
    }
  });

  it('nothing links to the removed account, pricing, share or legal pages', async () => {
    for (const page of PAGES) {
      const html = await render(page);
      expect(html).not.toMatch(/href="\/(pricing|account|login|verify|reset|auth|terms|privacy|refund|s\/)/);
      expect(html).not.toMatch(/pricing|subscription|checkout|billing|coupon|refund|password|share link|\$\d/i);
    }
  });
});

describe('with VITE_REPO_URL', () => {
  it('home links both installers to the latest release and the source to the README', async () => {
    const all = links(await render('home', { repo: `${REPO}/` }));
    expect(all).toContainEqual({ href: `${REPO}/releases/latest`, text: 'Windows installer (.exe)' });
    expect(all).toContainEqual({ href: `${REPO}/releases/latest`, text: 'macOS (.dmg)' });
    expect(all).toContainEqual({ href: `${REPO}#readme`, text: 'Build from source' });
    expect(all).toContainEqual({ href: REPO, text: 'GitHub' });
  });

  it('home no longer shows the placeholder note', async () => {
    expect(await render('home', { repo: REPO })).not.toContain('Download links appear here');
  });

  it.each(PAGES)('%s links outside the site only to the repository', async (page) => {
    const homeIds = ids(await render('home', { repo: REPO }));
    const allowed = new Set([REPO, `${REPO}/releases/latest`, `${REPO}#readme`, `${REPO}/issues`]);
    const all = links(await render(page, { repo: REPO }));
    for (const l of all) expect(allowed.has(l.href) || isLiveInternal(l.href, homeIds), `${page}: ${l.text} → "${l.href}"`).toBe(true);
    expect(all).toContainEqual({ href: `${REPO}/issues`, text: 'Report an issue' });
  });
});

describe('docs', () => {
  it('opens the section named by the URL hash', async () => {
    const html = await render('docs', { hash: '#privacy' });
    expect(html).toContain('<h1 class="text-2xl font-bold">Privacy</h1>');
    expect(html).toContain('Your recordings never leave your computer.');
    expect(html).toContain('no telemetry');
  });

  it.each(['', '#nope', '#pricing'])('falls back to Getting started for %j', async (hash) => {
    const html = await render('docs', { hash });
    expect(html).toContain('<h1 class="text-2xl font-bold">Getting started</h1>');
    expect(html).toContain('There is no account to create');
  });

  it('shows the 0.2.0 open-source release at the top of the changelog', async () => {
    const html = await render('docs', { hash: '#changelog' });
    const top = html.indexOf('0.2.0 · 2026-10-31');
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(html.indexOf('0.1.1 · 2026-10-30'));
    expect(html).toContain('Open-source release: no account needed — every feature is free and works offline;');
    expect(html).not.toContain('Text-to-speech avatars');
  });

  it('marks the open section in the sidebar', async () => {
    const html = await render('docs', { hash: '#faq' });
    expect(html).toMatch(/<button aria-current="page"[^>]*>FAQ<\/button>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
