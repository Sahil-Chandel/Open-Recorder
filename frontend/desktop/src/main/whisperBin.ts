import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Newer whisper.cpp archives still ship `main.exe`, but only as a stub that prints a deprecation notice and
 * exits 1 — so names are matched in preference order across the whole tree, never in directory order.
 */
export function findExe(dir: string, platform: string = process.platform): string | null {
  const names = platform === 'win32' ? ['whisper-cli.exe', 'main.exe'] : ['whisper-cli', 'main'];
  if (!existsSync(dir)) return null;
  const found = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (names.includes(e.name) && !found.has(e.name)) found.set(e.name, p);
    }
  };
  walk(dir);
  for (const n of names) if (found.has(n)) return found.get(n)!;
  return null;
}
