/**
 * project.json migration runner (task 0.7). Each migration upgrades version N → N+1 on raw JSON;
 * the final result is validated by the current zod schema. Unknown future versions are rejected.
 */
import { ProjectSchema, SCHEMA_VERSION, type Project } from './schema';

type Raw = Record<string, unknown> & { schemaVersion?: number };
export type Migration = (raw: Raw) => Raw;

/** migrations[n] upgrades schemaVersion n → n+1. v0 = pre-release drafts without schemaVersion. */
export const MIGRATIONS: Record<number, Migration> = {
  0: (raw) => ({
    ...raw,
    schemaVersion: 1,
    layouts: raw.layouts ?? [],
    annotations: raw.annotations ?? [],
    zooms: raw.zooms ?? [],
  }),
};

export class ProjectVersionError extends Error {}

export function migrateProject(input: unknown): Project {
  if (typeof input !== 'object' || input === null) throw new ProjectVersionError('project.json is not an object');
  let raw = { ...(input as Raw) };
  let v = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (v > SCHEMA_VERSION) throw new ProjectVersionError(`project schema v${v} is newer than this app (v${SCHEMA_VERSION}); please update`);
  while (v < SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new ProjectVersionError(`no migration from v${v}`);
    raw = m(raw);
    v = raw.schemaVersion ?? v + 1;
  }
  return ProjectSchema.parse(raw);
}