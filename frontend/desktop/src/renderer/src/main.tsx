import './styles.css';
import './fonts';
import './i18n';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from './i18n';
import { api, route } from './lib/api';
import { ConfirmProvider, Toaster, toast } from './ui';

const Recorder = lazy(() => import('./routes/Recorder'));
const AreaSelector = lazy(() => import('./routes/AreaSelector'));
const Countdown = lazy(() => import('./routes/Countdown'));
const ControlBar = lazy(() => import('./routes/ControlBar'));
const Teleprompter = lazy(() => import('./routes/Teleprompter'));
const SettingsPage = lazy(() => import('./routes/Settings'));
const Library = lazy(() => import('./routes/Library'));
const Onboarding = lazy(() => import('./routes/Onboarding'));
const Editor = lazy(() => import('./editor/Editor'));

const TRANSPARENT = new Set(['area', 'countdown', 'controlbar', 'teleprompter']);

/** 'system' follows the OS appearance (and keeps following it while the app runs). */
let themeSetting = 'dark';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme: string): void {
  themeSetting = theme;
  const dark = theme === 'system' ? darkQuery.matches : theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
darkQuery.addEventListener('change', () => themeSetting === 'system' && applyTheme('system'));

function App() {
  const [r, setR] = useState(route());
  useEffect(() => {
    const on = () => setR(route());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('transparent', TRANSPARENT.has(r.name));
    if (!window.api) return;
    void api.invoke<{ general: { language: string; theme: string } }>('settings:get').then((s) => {
      void i18n.changeLanguage(s.general.language);
      applyTheme(s.general.theme);
    });
    const offs = [
      api.on('settings:changed', (s: { general: { language: string; theme: string } }) => {
        void i18n.changeLanguage(s.general.language);
        applyTheme(s.general.theme);
      }),
      api.on('notify', (n: { kind: 'info' | 'warning' | 'error'; message: string }) => toast(n.message, n.kind)),
    ];
    return () => offs.forEach((o) => o());
  }, [r.name]);

  const page = (() => {
    switch (r.name) {
      case 'area': return <AreaSelector query={r.query} />;
      case 'countdown': return <Countdown query={r.query} />;
      case 'controlbar': return <ControlBar />;
      case 'teleprompter': return <Teleprompter />;
      case 'settings': return <SettingsPage />;
      case 'library': return <Library />;
      case 'onboarding': return <Onboarding />;
      case 'editor': return <Editor dir={r.query.get('dir') ?? ''} />;
      default: return <Recorder />;
    }
  })();
  return (
    <ConfirmProvider>
      <Suspense fallback={null}>{page}</Suspense>
      {!TRANSPARENT.has(r.name) && <Toaster />}
    </ConfirmProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
