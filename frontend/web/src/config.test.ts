import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeRepoUrl, repoLinks } from './config';

afterEach(() => { vi.unstubAllEnvs(); });

describe('normalizeRepoUrl', () => {
  it.each([undefined, null, 42, {}, '', '   '])('treats %j as unset', (raw) => {
    expect(normalizeRepoUrl(raw)).toBe('');
  });

  it.each([
    ['https://github.com/owner/recorder', 'https://github.com/owner/recorder'],
    ['  https://github.com/owner/recorder/  ', 'https://github.com/owner/recorder'],
    ['https://github.com/owner/recorder///', 'https://github.com/owner/recorder'],
    ['https://github.com/owner/recorder.git', 'https://github.com/owner/recorder'],
    ['https://github.com/owner/recorder.git/', 'https://github.com/owner/recorder'],
    ['https://github.com/owner/recorder?tab=readme-ov-file#readme', 'https://github.com/owner/recorder'],
    ['https://user:secret@github.com/owner/recorder', 'https://github.com/owner/recorder'],
    ['HTTPS://GitHub.com/owner/recorder', 'https://github.com/owner/recorder'],
    ['http://localhost:3000/owner/recorder', 'http://localhost:3000/owner/recorder'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeRepoUrl(raw)).toBe(want);
  });

  it.each(['github.com/owner/recorder', 'git@github.com:owner/recorder.git', 'javascript:alert(1)', 'ftp://example.com/recorder', 'file:///C:/recorder', 'https://', '/owner/recorder'])(
    'rejects %s (it would only produce dead links)',
    (raw) => { expect(normalizeRepoUrl(raw)).toBe(''); },
  );
});

describe('repoLinks', () => {
  it('derives the release, source and issue links', () => {
    expect(repoLinks('https://github.com/owner/recorder')).toEqual({
      repo: 'https://github.com/owner/recorder',
      releases: 'https://github.com/owner/recorder/releases/latest',
      source: 'https://github.com/owner/recorder#readme',
      issues: 'https://github.com/owner/recorder/issues',
    });
  });

  it('is null without a repository, so no link can be built', () => {
    expect(repoLinks('')).toBeNull();
  });
});

describe('REPO_URL / REPO', () => {
  const load = async (value: string | undefined) => {
    vi.stubEnv('VITE_REPO_URL', value);
    vi.resetModules();
    return import('./config');
  };

  it('come from VITE_REPO_URL, normalized', async () => {
    const c = await load(' https://github.com/owner/recorder.git/ ');
    expect(c.REPO_URL).toBe('https://github.com/owner/recorder');
    expect(c.REPO?.releases).toBe('https://github.com/owner/recorder/releases/latest');
  });

  it.each([undefined, '', 'not a url'])('are empty / null when VITE_REPO_URL is %j', async (value) => {
    const c = await load(value);
    expect(c.REPO_URL).toBe('');
    expect(c.REPO).toBeNull();
  });
});
