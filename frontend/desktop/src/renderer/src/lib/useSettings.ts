import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../../shared/ipc';
import { api } from './api';

/** Live settings snapshot + patch function (deep-merged and validated in main). */
export function useSettings(): [Settings | null, (patch: Record<string, unknown>) => Promise<void>] {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    void api.invoke<Settings>('settings:get').then(setS);
    return api.on('settings:changed', setS);
  }, []);
  const patch = useCallback(async (p: Record<string, unknown>) => {
    setS(await api.invoke<Settings>('settings:set', p));
  }, []);
  return [s, patch];
}
