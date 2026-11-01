// Collects the per-platform binaries electron-builder ships in resources/bin/<platform>-<arch> (task 14.1):
//  - Windows: the capture helper published SELF-CONTAINED (end users don't need .NET installed) + ffmpeg/ffprobe
//  - macOS:   the Swift capture helper for arm64 and x64 + ffmpeg/ffprobe per arch
// ffmpeg comes from FFMPEG_DIR (or FFMPEG_DIR_ARM64 / FFMPEG_DIR_X64 on macOS); when unset, the copy on PATH is used.
// Usage: node scripts/prepare-bin.mjs            (current OS)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const plat = process.platform;
const exe = plat === 'win32' ? '.exe' : '';

const outDir = (arch) => {
  const d = join(root, 'build', 'bin', `${plat}-${arch}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Directory holding ffmpeg/ffprobe for an arch: explicit env first, then whatever is on PATH. */
function ffmpegDir(arch) {
  const explicit = process.env[`FFMPEG_DIR_${arch.toUpperCase()}`] ?? process.env.FFMPEG_DIR;
  if (explicit) return explicit;
  try {
    const found = execFileSync(plat === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
    return found ? dirname(found) : null;
  } catch {
    return null;
  }
}

function copyFfmpeg(arch, out) {
  const dir = ffmpegDir(arch);
  if (!dir) throw new Error('[prepare-bin] ffmpeg not found — set FFMPEG_DIR (the app needs ffmpeg + ffprobe to record and export)');
  // ffprobe is optional (the app reads media info from `ffmpeg -i` without it) — bundling it adds ~230 MB
  for (const b of process.env.BUNDLE_FFPROBE === '1' ? ['ffmpeg', 'ffprobe'] : ['ffmpeg']) {
    const src = join(dir, b + exe);
    if (!existsSync(src)) throw new Error(`[prepare-bin] ${src} is missing`);
    copyFileSync(src, join(out, b + exe));
  }
  console.log(`[prepare-bin] ffmpeg (${arch}) from ${dir}`);
}

if (plat === 'win32') {
  const arch = process.env.TARGET_ARCH ?? 'x64';
  const out = outDir(arch);
  const proj = join(repo, 'backend', 'native', 'win-helper');
  const pub = join(proj, 'publish');
  execFileSync('dotnet', [
    'publish', proj, '-c', 'Release', '-r', `win-${arch}`, '--self-contained', 'true',
    // native DLLs stay next to the exe: a single file would unpack them into %TEMP% on every user's machine
    '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=false', '-p:EnableCompressionInSingleFile=true', '-p:DebugType=none', '-o', pub,
  ], { stdio: 'inherit' });
  for (const f of readdirSync(pub)) if (/\.(exe|dll)$/i.test(f)) copyFileSync(join(pub, f), join(out, f));
  copyFfmpeg(arch, out);
  console.log('[prepare-bin] binaries →', out);
} else if (plat === 'darwin') {
  const proj = join(repo, 'backend', 'native', 'mac-helper');
  for (const arch of (process.env.TARGET_ARCHS ?? 'arm64,x64').split(',')) {
    const out = outDir(arch);
    const swiftArch = arch === 'arm64' ? 'arm64' : 'x86_64';
    execFileSync('swift', ['build', '-c', 'release', '--package-path', proj, '--arch', swiftArch], { stdio: 'inherit' });
    copyFileSync(join(proj, '.build', `${swiftArch}-apple-macosx`, 'release', 'MacHelper'), join(out, 'mac-helper'));
    copyFfmpeg(arch, out);
    console.log('[prepare-bin] binaries →', out);
  }
} else {
  throw new Error(`[prepare-bin] unsupported platform ${plat} — capture helpers exist for Windows and macOS only`);
}
