/**
 * Preset storage (PRE-01…04, REC-15): userData/presets/<id>.preset.json + default id in settings.
 */
import { app, dialog } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { applyPreset, isProjectAssetRef, mapPresetAssets, parsePreset, PresetSchema, serializePreset, uid, type Preset, type Project } from '@rec/shared';
import { logger } from './log';
import { settings } from './settings';

const dir = () => {
  const d = join(app.getPath('userData'), 'presets');
  mkdirSync(d, { recursive: true });
  return d;
};

export function listPresets(): Preset[] {
  const out: Preset[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.preset.json')) continue;
    try {
      out.push(PresetSchema.parse(JSON.parse(readFileSync(join(dir(), f), 'utf8'))));
    } catch (e) {
      logger.warn('presets.invalid', { file: f, message: (e as Error).message });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Preset asset refs look like `preset:<id>/<file>` and live in presets/<id>/. */
const PRESET_REF = /^preset:([\w-]+)\/([^/\\]+)$/;

/** Copy files a preset references from its source project into presets/<id>/ and point the refs there. */
function captureAssets(p: Preset, projectDir: string): Preset {
  return mapPresetAssets(p, (ref) => {
    if (!isProjectAssetRef(ref)) return ref;
    const src = join(projectDir, ref);
    if (!existsSync(src)) return ref;
    const name = basename(ref).replace(/[^\w.-]+/g, '_');
    mkdirSync(join(dir(), p.id), { recursive: true });
    copyFileSync(src, join(dir(), p.id, name));
    return `preset:${p.id}/${name}`;
  });
}

/** Copy a preset's assets into a project (assets/) and return the preset with project-relative refs. */
export function materializePreset(p: Preset, projectDir: string): Preset {
  return mapPresetAssets(p, (ref) => {
    const m = PRESET_REF.exec(ref);
    if (!m) return ref;
    const src = join(dir(), m[1]!, m[2]!);
    if (!existsSync(src)) return ref;
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    const rel = `assets/${m[1]}-${m[2]}`;
    if (!existsSync(join(projectDir, rel))) copyFileSync(src, join(projectDir, rel));
    return rel;
  });
}

export function savePreset(raw: unknown, projectDir?: string): Preset {
  let p = PresetSchema.parse(raw);
  if (!/^[\w-]+$/.test(p.id)) throw new Error('invalid preset id');
  if (projectDir) p = captureAssets(p, projectDir);
  delete p.assets; // embedded copies only exist in exported files
  const f = join(dir(), `${p.id}.preset.json`);
  writeFileSync(`${f}.tmp`, serializePreset(p));
  renameSync(`${f}.tmp`, f);
  return p;
}

/** Presets are user data: "delete" moves the file into presets/.deleted so it can be recovered. */
export function deletePreset(id: string): void {
  if (!/^[\w-]+$/.test(id)) throw new Error('invalid preset id');
  const f = join(dir(), `${id}.preset.json`);
  if (!existsSync(f)) return;
  const bin = join(dir(), '.deleted');
  mkdirSync(bin, { recursive: true });
  renameSync(f, join(bin, `${id}.${Date.now()}.preset.json`));
  if (settings.get().defaultPresetId === id) settings.set({ defaultPresetId: undefined });
}

export function setDefaultPreset(id: string | null): void {
  const s = settings.get();
  settings.set({ ...s, defaultPresetId: id ?? undefined });
}

/** REC-15. Pass the bundle dir so the preset's images are copied into the new project. */
export function applyDefaultPreset(project: Project, projectDir?: string): Project {
  const id = settings.get().defaultPresetId;
  if (!id) return project;
  const preset = listPresets().find((p) => p.id === id);
  if (!preset) return project;
  return applyPreset(project, projectDir ? materializePreset(preset, projectDir) : preset).project;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.cur': 'image/x-icon', '.ico': 'image/x-icon' };

export async function importPresetFile(): Promise<Preset | null> {
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Preset', extensions: ['json'] }] });
  const f = r.filePaths[0];
  if (r.canceled || !f) return null;
  const parsed = parsePreset(readFileSync(f, 'utf8'));
  // a new id avoids clobbering an existing preset; embedded assets are unpacked into presets/<id>/
  const id = listPresets().some((x) => x.id === parsed.id) ? uid('pre') : parsed.id;
  const assets = parsed.assets ?? {};
  const unpacked = mapPresetAssets({ ...parsed, id }, (ref) => {
    const data = assets[ref];
    const m = PRESET_REF.exec(ref);
    if (!data || !m) return ref;
    const b64 = /^data:[^;]+;base64,(.*)$/.exec(data)?.[1];
    if (!b64) return ref;
    mkdirSync(join(dir(), id), { recursive: true });
    writeFileSync(join(dir(), id, m[2]!), Buffer.from(b64, 'base64'));
    return `preset:${id}/${m[2]}`;
  });
  return savePreset(unpacked);
}

export async function exportPresetFile(id: string): Promise<string | null> {
  const p = listPresets().find((x) => x.id === id);
  if (!p) throw new Error('preset not found');
  const r = await dialog.showSaveDialog({ defaultPath: `${p.name}.preset.json` });
  if (r.canceled || !r.filePath) return null;
  // embed images so the file works on another computer (PRE-04 shareable presets)
  const assets: Record<string, string> = {};
  mapPresetAssets(p, (ref) => {
    const m = PRESET_REF.exec(ref);
    const f = m ? join(dir(), m[1]!, m[2]!) : null;
    if (f && existsSync(f)) assets[ref] = `data:${MIME[extname(f).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(f).toString('base64')}`;
    return ref;
  });
  writeFileSync(r.filePath, serializePreset({ ...p, ...(Object.keys(assets).length ? { assets } : {}) }));
  return r.filePath;
}
