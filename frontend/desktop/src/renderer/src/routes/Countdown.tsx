/** Countdown overlay (task 2.3, REC-08) — excluded from capture via content protection. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function Countdown({ query }: { query: URLSearchParams }) {
  const [n, setN] = useState(Number(query.get('secs') ?? 3));
  useEffect(() => {
    if (n <= 0) {
      void api.invoke('countdown:done');
      return;
    }
    const t = setTimeout(() => setN(n - 1), 1000);
    return () => clearTimeout(t);
  }, [n]);
  return (
    <div className="flex h-full items-center justify-center">
      <div key={n} className="flex h-56 w-56 items-center justify-center rounded-full bg-black/70 text-8xl font-bold text-white shadow-2xl animate-[ping_1s_ease-out_reverse]">
        {n > 0 ? n : ''}
      </div>
    </div>
  );
}