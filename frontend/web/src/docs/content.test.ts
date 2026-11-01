import { describe, expect, it } from 'vitest';
import { CHANGELOG, CHANGELOG_ID, GUIDES, ROADMAP, SHIPPED, sectionFromHash } from './content';

const guideText = (id: string): string => GUIDES.find((g) => g.id === id)?.body.join(' ') ?? '';
const semver = (v: string): number[] => v.split('.').map(Number);
const newer = (a: string, b: string): boolean => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

describe('guides', () => {
  it('have unique ids (they are URL hashes), titles and content', () => {
    const ids = GUIDES.map((g) => g.id);
    expect(new Set([...ids, CHANGELOG_ID]).size).toBe(ids.length + 1);
    for (const g of GUIDES) {
      expect(g.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(g.title.trim()).not.toBe('');
      expect(g.body.length).toBeGreaterThan(0);
      for (const p of g.body) expect(p.trim()).not.toBe('');
    }
  });

  it('describe no account, paid, or cloud features', () => {
    const all = GUIDES.flatMap((g) => [g.title, ...g.body]).join('\n');
    for (const banned of [/\bcloud\b/i, /share link/i, /subscription/i, /\bpric(e|es|ing)\b/i, /checkout|billing|coupon|refund/i, /\bavatars?\b/i, /\b(advanced|standard) plan\b/i, /\b(activat|unbind)/i, /\bupgrade\b/i]) {
      expect(all).not.toMatch(banned);
    }
  });

  it('say that captions and vocal enhancement run locally', () => {
    expect(guideText('captions')).toContain('generated on your computer with whisper.cpp');
    expect(guideText('captions')).toContain('downloaded once, the first time you generate captions');
    expect(guideText('audio')).toMatch(/Vocal Enhancement .*processed on your computer/);
    expect(guideText('editor')).toContain('Pro Edit');
  });

  it('include a privacy section: nothing leaves the computer, no account, no telemetry', () => {
    const privacy = guideText('privacy');
    expect(privacy).toContain('Your recordings never leave your computer');
    expect(privacy).toContain('no account');
    expect(privacy).toContain('no telemetry');
  });
});

describe('changelog & roadmap', () => {
  it('lead with the 0.2.0 open-source release', () => {
    expect(CHANGELOG[0]).toEqual({
      v: '0.2.0',
      date: '2026-10-31',
      notes: ['Open-source release: no account needed — every feature is free and works offline; removed cloud share links, cloud captions and AI avatars (they needed a hosted service); vocal enhancement now runs locally.'],
    });
  });

  it('list releases newest first with ISO dates', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const [prev, cur] = [CHANGELOG[i - 1]!, CHANGELOG[i]!];
      expect(newer(prev.v, cur.v), `${prev.v} before ${cur.v}`).toBe(true);
      expect(prev.date >= cur.date).toBe(true);
    }
    for (const c of CHANGELOG) {
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.notes.length).toBeGreaterThan(0);
    }
  });

  it('plan nothing that needs a hosted service', () => {
    expect([...SHIPPED, ...ROADMAP].join('\n')).not.toMatch(/avatar|cloud/i);
  });
});

describe('sectionFromHash', () => {
  it.each([
    ['#privacy', 'privacy'],
    ['privacy', 'privacy'],
    ['#changelog', CHANGELOG_ID],
    ['#faq', 'faq'],
  ])('%s → %s', (hash, want) => {
    expect(sectionFromHash(hash)).toBe(want);
  });

  it.each(['', '#', '#pricing', '#__proto__', '#constructor', '#Privacy', '#%70rivacy'])('falls back to the first guide for %j', (hash) => {
    expect(sectionFromHash(hash)).toBe(GUIDES[0]!.id);
  });
});
