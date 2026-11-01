/**
 * Docs / guide content (task 14.8) as data: user guides mirroring the desktop app's feature set, privacy, FAQ,
 * changelog and public roadmap. Every section is deep-linkable as /docs#<id>.
 */
export interface Guide { id: string; title: string; body: string[] }
export interface Release { v: string; date: string; notes: string[] }

export const GUIDES: readonly Guide[] = [
  { id: 'start', title: 'Getting started', body: ['Install the app — the Windows installer (.exe) or the macOS disk image (.dmg) from the latest release, or build it from source — allow the permissions it asks for (camera, microphone; on macOS also Screen Recording and Accessibility) and press the purple REC button. There is no account to create and nothing to sign in to.', 'When you stop, the editor opens with automatic zooms, a smooth cursor and your default preset already applied.'] },
  { id: 'record', title: 'Recording', body: ['Choose Full Screen (pick a display), Window (thumbnail picker with search) or Custom (drag an area, lock 16:9 / 9:16 / 1:1 / 4:3, Enter to confirm).', 'Toggle camera, microphone and system audio; pick “Only this app” to record a single application’s sound.', 'Press Test microphone in the recorder to record three seconds and hear them played back, so you know your audio works before you start.', 'Global shortcuts start, pause and finish recordings without opening the app. The countdown, control bar and teleprompter never appear in the video.', 'If the app or computer crashes, the next launch offers to restore the recording up to the last ~2 seconds.'] },
  { id: 'teleprompter', title: 'Teleprompter', body: ['Open it from the recorder, paste your script, set speed, font size, color and background opacity. It scrolls when recording starts (Space pauses) and is invisible to the capture.'] },
  { id: 'mobile', title: 'Android & iPhone', body: ['Android 11+: enable USB debugging, connect with a cable, accept the prompt, then Start mirroring → Record. Device audio is a separate track; your mic is recorded from the computer.', 'iPhone/iPad: supported on macOS (trust the computer). Device recordings have no cursor data, so auto zoom is off — add zooms manually.'] },
  { id: 'editor', title: 'Editor basics', body: ['Split with C, delete clips (ripple), drag clip edges to trim, set per-clip speed (typing chips suggest 2–4× speed-ups) and per-clip audio volume.', 'Everything is undoable; projects auto-save every couple of seconds. Copy/paste properties between zooms, clips and annotations.', 'One-click Pro Edit runs Smart Cut, captions, noise reduction and automatic zooms and applies your default preset in one step, all on your computer — a single Undo reverts it.'] },
  { id: 'zoom', title: 'Zoom, pan & 3D motion', body: ['Zooms are created from clicks and typing. Drag them on the blue track, change the level (1–4×), follow the cursor or pin a focus point, split and apply settings to all.', 'Switch any zoom to 3D Motion: automatic tilt that follows the mouse (Subtle / Default / Strong) or manual tilt, field of view and position, plus entrance and showcase recipes.', 'Animations → Zoom & pan speed controls the spring (Slow by default) or custom tension / friction / mass.'] },
  { id: 'cursor', title: 'Cursor', body: ['40 styles, size, color, angle and dynamic direction, 8 click effects and click sounds. Hide the cursor when idle, smooth its path, and choose whether it stays or returns to the start at the end.', 'Import your own cursor image (PNG, JPG or SVG) from the Cursor panel to replace the built-in styles.'] },
  { id: 'camera', title: 'Camera', body: ['Pick a layout (corner, side-by-side, behind, camera only, screen only; portrait layouts for 9:16), or Adjust Layout to drag it yourself. Add layout segments on the timeline for animated switches.', 'Style: size, roundness up to a circle, frames, border, mirror/flip, filters, a beauty filter and shrink while zoomed. Background: remove, blur, image or color — no green screen.'] },
  { id: 'annotations', title: 'Annotations, masks & keyboard', body: ['Add text (basic, title, label), arrows, lines, shapes and highlights; blur/mosaic, spotlight, magnifier and callout masks stick to the screen content while zooming.', 'Shortcuts you pressed are shown as key caps; hide individual ones or turn on single keys. Plain typing is never shown or stored.'] },
  { id: 'audio', title: 'Audio & music', body: ['Mic and system volume up to 300 %, noise reduction, smart volume balancing and Vocal Enhancement (studio voice: de-noise, de-ess, EQ, compression and level) — all processed on your computer.', 'Background music: 12 original royalty-free tracks or your own file; trim, fade, loop, set the range and duck it under your voice.'] },
  { id: 'captions', title: 'Captions & Smart Cut', body: ['Captions are generated on your computer with whisper.cpp: pick the Nano, Basic or Pro model (larger is more accurate, smaller is faster). The model — and on Windows the whisper.cpp engine — is downloaded once, the first time you generate captions, and works offline after that.', 'Edit in the list: Enter splits, Shift+Enter breaks a line. Import SRT, export SRT/VTT, choose one of 5 styles.', 'Smart Cut finds pauses and filler words; review the transcript, untick what you want to keep and press Delete. Reset restores everything.'] },
  { id: 'presets', title: 'Presets & watermark', body: ['Save your look (canvas, cursor, camera, captions style, watermark…) as a preset, set one as default for new recordings, and share presets as files.', 'Add a PNG/JPG/SVG watermark, drag it into place and set size and opacity.'] },
  { id: 'export', title: 'Export', body: ['Export MP4 up to 4K 60 fps or GIF; save your favorite settings as default. After exporting you can copy the file to the clipboard or open its folder.', 'Social presets — YouTube and Shorts, Instagram Reels and posts, TikTok, LinkedIn, X and Facebook — set the canvas size and export settings, show safe-zone guides for each app’s buttons and captions, and warn you when a video is longer than the platform allows.'] },
  { id: 'privacy', title: 'Privacy', body: ['Your recordings never leave your computer. Recording, editing, captions, Smart Cut, noise reduction, vocal enhancement and export all run locally — nothing is uploaded.', 'There is no account and no sign-in, and the app sends no telemetry: no usage statistics, no analytics, no tracking.', 'Models are downloaded once, the first time a feature needs them (whisper.cpp for captions, a small segmentation model for camera background removal); your audio and video are processed on your computer and never sent anywhere.', 'The online recorders on this website work the same way: they run entirely in your browser and never upload what you record.'] },
  { id: 'faq', title: 'FAQ', body: ['Is it really free? Yes. The app is open source and every feature is included — there are no plans, credits or sign-ins.', 'Is my screen uploaded? No. Recordings, projects and exports stay on your computer, and captions and vocal enhancement are processed locally too.', 'Why is the video black for some apps? DRM-protected video (e.g. some streaming apps) cannot be captured — that is expected.', 'My laptop has two GPUs and capture fails: we use Windows Graphics Capture which works across GPUs; update your graphics drivers if problems persist.'] },
];

/** Newest first. */
export const CHANGELOG: readonly Release[] = [
  { v: '0.2.0', date: '2026-10-31', notes: ['Open-source release: no account needed — every feature is free and works offline; removed cloud share links, cloud captions and AI avatars (they needed a hosted service); vocal enhancement now runs locally.'] },
  { v: '0.1.1', date: '2026-10-30', notes: [
    'Social-platform canvas presets: YouTube Shorts, Instagram Reels and posts, TikTok, LinkedIn, X and Facebook, with safe-zone guides that keep captions and key content clear of each app’s buttons.',
    'Fixed the captions engine: local captions generate reliably again.',
    'Fixed a crash when stopping a recording.',
    'Safer default shortcuts that no longer clash with other apps — Alt+Shift on Windows, ⌘⌥ on macOS. Pause and finish are only active while recording, and shortcuts that can’t be registered are flagged in Settings.',
  ] },
  { v: '0.1.0', date: '2026-10-30', notes: ['First release: recorder, auto-zoom editor, cursor engine, camera layouts, annotations, audio suite, captions, Smart Cut, presets, Android recording, cloud share and AI features.'] },
];

export const SHIPPED: readonly string[] = ['Test audio before recording', 'Custom cursor import'];
export const ROADMAP: readonly string[] = ['Several recordings on one timeline', 'Intro / outro and title cards', 'B-roll and media import', 'Google Drive / YouTube / Dropbox export', 'Looping video backgrounds'];

/** The combined "Changelog & roadmap" section. */
export const CHANGELOG_ID = 'changelog';
const SECTION_IDS: ReadonlySet<string> = new Set([...GUIDES.map((g) => g.id), CHANGELOG_ID]);

/** The section a URL hash (`#privacy`, or '') points to; unknown ids fall back to the first guide. */
export function sectionFromHash(hash: string): string {
  const id = hash.replace(/^#/, '');
  return SECTION_IDS.has(id) ? id : GUIDES[0]!.id;
}
