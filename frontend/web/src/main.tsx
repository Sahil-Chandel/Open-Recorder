import './styles.css';
import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const Home = lazy(() => import('./pages/Home'));
const Tools = lazy(() => import('./tools/Tools'));
const Docs = lazy(() => import('./pages/Docs'));

export function navigate(to: string): void {
  history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (!to.includes('#')) window.scrollTo(0, 0);
}

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const tool = /^\/tools\/(screen|camera|mic)-recorder$/.exec(path);
  const page = tool ? <Tools key={tool[1]} mode={tool[1] as 'screen' | 'camera' | 'mic'} />
    : path === '/docs' ? <Docs />
    : <Home />;
  return <Suspense fallback={<div className="p-10 text-center text-muted">Loading…</div>}>{page}</Suspense>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
