/** Shared site chrome: client-side links, the top navigation and the footer. Repository links only exist once REPO_URL is set. */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { PRODUCT, REPO } from '../config';
import { navigate } from '../main';

type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; children: ReactNode };

/** A real <a href> (so middle-click / open-in-new-tab work) that navigates client-side on a plain left click. */
export function AppLink({ to, onClick, children, ...rest }: AppLinkProps) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={go}>{children}</a>;
}

const NAV = [
  { to: '/docs', label: 'Guide' },
  { to: '/#download', label: 'Download' },
] as const;

export function SiteNav({ className = '' }: { className?: string }) {
  const here = location.pathname;
  return (
    <nav aria-label="Main" className={`flex items-center justify-between text-sm ${className}`}>
      <AppLink to="/" className="flex items-center gap-2 font-semibold"><span className="h-3 w-3 rounded-full bg-accent" />{PRODUCT}</AppLink>
      <div className="flex flex-wrap justify-end gap-x-5 gap-y-1 text-muted">
        {NAV.map((n) => (
          <AppLink key={n.to} to={n.to} aria-current={here === n.to ? 'page' : undefined} className={here === n.to ? 'text-text' : 'hover:text-text'}>{n.label}</AppLink>
        ))}
        {REPO && <a href={REPO.repo} className="hover:text-text">GitHub</a>}
      </div>
    </nav>
  );
}

const FOOTER = [
  { to: '/docs', label: 'Guide' },
  { to: '/docs#privacy', label: 'Privacy' },
  { to: '/docs#changelog', label: 'Changelog' },
] as const;

export function SiteFooter({ className = '' }: { className?: string }) {
  return (
    <footer className={`mt-16 flex flex-col gap-3 border-t border-line pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <span>© {new Date().getFullYear()} {PRODUCT} · Free and open source</span>
      <nav aria-label="Help and project" className="flex flex-wrap gap-x-5 gap-y-2">
        {FOOTER.map((f) => <AppLink key={f.to} to={f.to} className="hover:text-text">{f.label}</AppLink>)}
        {REPO && (
          <>
            <a href={REPO.repo} className="hover:text-text">Source code</a>
            <a href={REPO.issues} className="hover:text-text">Report an issue</a>
          </>
        )}
      </nav>
    </footer>
  );
}
