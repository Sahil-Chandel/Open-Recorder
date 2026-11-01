/**
 * Site-wide constants and build-time configuration.
 *
 * VITE_REPO_URL is the project's public repository (e.g. https://github.com/owner/recorder), set when the site is
 * built. Every download / source / issue link is derived from it; while it is unset the site shows no repository
 * links at all — never dead ones.
 */
export const PRODUCT = 'Open-Recorder';

/**
 * The repository's base URL: origin + path, without trailing slashes, a `.git` suffix (a pasted clone URL), query,
 * hash or credentials. Anything that isn't an absolute http(s) URL counts as unset ('').
 */
export function normalizeRepoUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return '';
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return '';
  return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`;
}

export const REPO_URL = normalizeRepoUrl((import.meta.env.VITE_REPO_URL as string | undefined) ?? '');

export interface RepoLinks {
  /** Repository home page. */
  repo: string;
  /** Latest release (GitHub): the Windows installer and the macOS disk image are attached there. */
  releases: string;
  /** README with the build-from-source instructions. */
  source: string;
  issues: string;
}

/** Links derived from a repository URL, or null when there is none — so callers can't render a dead link. */
export function repoLinks(repo: string): RepoLinks | null {
  return repo ? { repo, releases: `${repo}/releases/latest`, source: `${repo}#readme`, issues: `${repo}/issues` } : null;
}

export const REPO = repoLinks(REPO_URL);
