/**
 * Typed IPC contract (task 0.2). One table of channels; inputs validated with zod in main
 * (renderer is untrusted). Preload exposes only `invoke` for allow-listed channels and `on` for events.
 */
import { z } from 'zod';
import { ExportSettingsSchema, ProjectSchema, RecordingConfigSchema } from '@rec/shared';

/** binary payloads arrive as ArrayBuffer or Uint8Array depending on the sender */
export const Bytes = z.union([z.instanceof(ArrayBuffer), z.instanceof(Uint8Array)]);

export const AreaSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), displayId: z.string() });
export type Area = z.infer<typeof AreaSchema>;

export const StartRecordingSchema = z.object({
  mode: z.enum(['display', 'window', 'area']),
  displayId: z.string(),
  windowId: z.string().optional(),
  area: AreaSchema.optional(),
  camera: z.object({ enabled: z.boolean(), deviceId: z.string().optional() }),
  mic: z.object({ enabled: z.boolean(), deviceId: z.string().optional() }),
  systemAudio: z.object({ enabled: z.boolean(), deviceId: z.string().optional(), appPid: z.number().optional() }),
  zoomMode: z.enum(['2d', '3d']).default('2d'),
});
export type StartRecordingInput = z.infer<typeof StartRecordingSchema>;

export const SettingsSchema = z.object({
  general: z.object({
    saveDir: z.string(),
    exportDir: z.string(),
    launchAtLogin: z.boolean(),
    autoplayInEditor: z.boolean(),
    language: z.string(),
    recordingEngine: z.enum(['modern', 'traditional']),
    theme: z.enum(['dark', 'light', 'system']),
    previewQuality: z.enum(['auto', 'high', 'low']).default('auto'),
    gpuHintShown: z.boolean().default(false),
    tourDone: z.boolean().default(false),
  }),
  record: z.object({
    autoZoom: z.boolean(),
    zoomMode: z.enum(['2d', '3d']),
    hideDesktopIcons: z.boolean(),
    hideTaskbar: z.boolean(),
    quality: z.enum(['low', 'medium', 'high', 'lossless']),
    fps: z.union([z.literal(30), z.literal(60)]),
    countdown: z.number().int().min(0).max(10),
    encoder: z.enum(['auto', 'nvenc', 'qsv', 'amf', 'x264', 'videotoolbox']),
  }),
  shortcuts: z.object({
    record: z.record(z.string(), z.string()),
    edit: z.record(z.string(), z.string()),
  }),
  export: ExportSettingsSchema.omit({ name: true, dir: true }),
  devices: z.object({
    cameraEnabled: z.boolean(),
    cameraId: z.string().optional(),
    micEnabled: z.boolean(),
    micId: z.string().optional(),
    systemAudioEnabled: z.boolean(),
    outputId: z.string().optional(),
    appPid: z.number().optional(),
    lastArea: AreaSchema.optional(),
    lastMode: z.enum(['display', 'window', 'area']).default('display'),
  }),
  teleprompter: z.object({
    script: z.string().max(200_000),
    speed: z.number().min(0.1).max(10),
    fontSize: z.number().min(12).max(120),
    color: z.string(),
    bgOpacity: z.number().min(0).max(1),
    bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  }),
  defaultPresetId: z.string().optional(),
  onboardingDone: z.boolean(),
  analyticsOptIn: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export interface ProjectSummary {
  id: string;
  name: string;
  dir: string;
  createdAt: string;
  lastOpenedAt: string;
  durationSec: number;
  thumbnail: string | null; // rec-media:// URL
  sizeBytes: number;
}

export interface OpenedProject {
  dir: string;
  project: z.infer<typeof ProjectSchema>;
  telemetryRaw: { cursorB64: string; clicks: string; keys: string };
  mediaBase: string; // rec-media URL prefix for this bundle
  cursorBitmaps: Array<{ id: number; url: string; hotspot: [number, number] }>;
}

export const ExportBeginSchema = z.object({ path: z.string(), format: z.enum(['mp4', 'gif']), gifFps: z.number().optional(), gifWidth: z.number().optional() });

/** Android device mode (DEV-01…06). The serial goes into adb argv (no shell), so a plain charset suffices. */
export const AndroidStartSchema = z.object({
  serial: z.string().min(1).max(200).regex(/^[\w.:%@[\]-]+$/),
  maxFps: z.number().int().min(1).max(120).optional(),
  bitrate: z.number().int().min(500_000).max(50_000_000).optional(),
});
/** Which computer inputs a device take records; device ids come from settings.devices in main. */
export const AndroidRecordSchema = z.object({ mic: z.boolean(), systemAudio: z.boolean(), camera: z.boolean() });
export type AndroidRecordInput = z.infer<typeof AndroidRecordSchema>;
/** tracks recorded by the renderer (MediaRecorder) and streamed into the bundle */
export const AndroidTrackSchema = z.enum(['camera', 'mic']);
export type AndroidTrack = z.infer<typeof AndroidTrackSchema>;

/** invoke channels → validator for args (tuple). `null` = no args. */
export const INVOKE = {
  'app:info': null,
  'app:openExternal': z.tuple([z.string().url()]),
  'app:showItemInFolder': z.tuple([z.string()]),
  'app:openPath': z.tuple([z.string()]),
  'app:copyFileToClipboard': z.tuple([z.string()]),
  'app:openLogs': null,
  'app:checkUpdates': null,
  'settings:get': null,
  'settings:set': z.tuple([z.record(z.string(), z.unknown())]),
  'hotkeys:status': null,
  'devices:displays': null,
  'devices:windows': null,
  'devices:windowThumbnail': z.tuple([z.string()]),
  'devices:audioInputs': null,
  'devices:audioOutputs': null,
  'devices:audioApps': null,
  'devices:startLevels': z.tuple([z.object({ micId: z.string().optional(), outputId: z.string().optional() })]),
  'devices:stopLevels': null,
  'permissions:status': null,
  'permissions:open': z.tuple([z.enum(['screen', 'camera', 'microphone', 'accessibility'])]),
  'helper:status': null,
  'rec:start': z.tuple([StartRecordingSchema]),
  'rec:pause': null,
  'rec:resume': null,
  'rec:stop': null,
  'rec:restart': null,
  'rec:discard': null,
  'rec:status': null,
  'rec:toggleMicMute': null,
  'rec:toggleKeyCapture': null,
  'rec:cameraChunk': z.tuple([Bytes]),
  'rec:cameraStarted': z.tuple([z.number()]),
  'rec:cameraDone': null,
  'area:select': z.tuple([z.string().optional()]),
  'area:done': z.tuple([AreaSchema.nullable()]),
  'countdown:done': null,
  'win:open': z.tuple([z.enum(['recorder', 'editor', 'settings', 'teleprompter', 'library', 'onboarding']), z.record(z.string(), z.string()).optional()]),
  'win:close': null,
  'win:minimize': null,
  'win:setSize': z.tuple([z.number(), z.number()]),
  'projects:list': null,
  'projects:open': z.tuple([z.string()]),
  'projects:save': z.tuple([z.string(), ProjectSchema]),
  'projects:saveAs': z.tuple([z.string(), ProjectSchema]),
  'projects:rename': z.tuple([z.string(), z.string().min(1).max(200)]),
  'projects:delete': z.tuple([z.array(z.string())]),
  'projects:import': null,
  'projects:extract': z.tuple([z.string()]),
  'projects:writeCache': z.tuple([z.string(), z.string(), Bytes]),
  'projects:readCache': z.tuple([z.string(), z.string()]),
  'projects:listCache': z.tuple([z.string(), z.string()]),
  'audio:enhanceVoice': z.tuple([z.string(), z.string()]),
  'projects:importAsset': z.tuple([z.string(), z.enum(['music', 'watermark', 'background', 'camera-bg', 'srt', 'facecam', 'background-video'])]),
  'projects:restorePending': null,
  'projects:sample': null,
  'projects:restore': z.tuple([z.string()]),
  'export:writeText': z.tuple([z.string().min(1).max(200), z.string().max(5_000_000)]),
  'export:chooseDir': z.tuple([z.string().optional()]),
  'export:begin': z.tuple([ExportBeginSchema]),
  'export:write': z.tuple([z.number(), z.number(), Bytes]),
  'export:finish': z.tuple([z.number()]),
  'export:abort': z.tuple([z.number()]),
  'presets:list': null,
  'presets:save': z.tuple([z.unknown(), z.string().optional()]),
  'presets:materialize': z.tuple([z.string(), z.string()]),
  'presets:delete': z.tuple([z.string()]),
  'presets:setDefault': z.tuple([z.string().nullable()]),
  'presets:import': null,
  'presets:export': z.tuple([z.string()]),
  'dialog:openFile': z.tuple([z.array(z.object({ name: z.string(), extensions: z.array(z.string()) }))]),
  'models:ensure': z.tuple([z.enum(['selfie', 'whisper-nano', 'whisper-basic', 'whisper-pro'])]),
  'asr:models': null,
  'asr:download': z.tuple([z.enum(['nano', 'basic', 'pro'])]),
  'asr:transcribe': z.tuple([z.object({ dir: z.string(), model: z.enum(['nano', 'basic', 'pro']), language: z.string(), files: z.array(z.string()) })]),
  'audio:denoise': z.tuple([z.object({ dir: z.string(), files: z.array(z.string()) })]),
  'android:adbStatus': null,
  'android:installAdb': null,
  'android:devices': null,
  'android:start': z.tuple([AndroidStartSchema]),
  'android:stop': null,
  'android:record': z.tuple([AndroidRecordSchema]),
  'android:recordStop': null,
  'android:trackStart': z.tuple([AndroidTrackSchema, z.number().positive()]),
  'android:trackChunk': z.tuple([AndroidTrackSchema, Bytes]),
  'android:trackDone': z.tuple([AndroidTrackSchema]),
} as const;
export type InvokeChannel = keyof typeof INVOKE;

/** main → renderer events */
export const EVENTS = [
  'rec:state',
  'rec:levels',
  'rec:tick',
  'helper:state',
  'devices:changed',
  'settings:changed',
  'hotkey',
  'menu',
  'notify',
  'teleprompter:control',
  'area:init',
  'countdown:init',
  'project:opened',
  'asr:progress',
  'audio:progress',
  'android:frame',
  'android:state',
  'android:adbProgress',
] as const;
export type EventChannel = (typeof EVENTS)[number];

export interface RecState {
  state: 'idle' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'error';
  elapsedSec: number;
  micMuted: boolean;
  /** keystroke capture paused (privacy); mouse and screen keep recording */
  keysPaused?: boolean;
  error?: string;
  dir?: string;
}

/** `android:state` event: lifecycle of a device take (every stop path ends in saved | error). */
export interface AndroidRecState {
  state: 'recording' | 'finalizing' | 'saved' | 'error';
  dir: string;
  /** why the take was finalised: user | disconnected | window-closed | restart | quit */
  reason?: string;
  error?: string;
}

/** `android:adbStatus` / `android:installAdb` result */
export interface AdbStatus {
  found: boolean;
  path: string | null;
  source: 'env' | 'bundled' | 'sdk' | 'path' | 'downloaded' | null;
  canDownload: boolean;
  installing: boolean;
}

/** `android:adbProgress` event while platform-tools are downloaded */
export interface AdbProgress {
  phase: 'download' | 'extract' | 'verify' | 'done';
  received: number;
  total: number | null;
}

/** `android:start` result */
export interface AndroidMirrorInfo {
  width: number;
  height: number;
  name: string;
  /** device audio (Android 11+) */
  audio: boolean;
  /** the computer's system audio can be recorded alongside (capture helper) */
  systemAudio: boolean;
}

/** `android:record` result: the renderer records the mic itself only when the helper cannot. */
export interface AndroidRecordResult {
  dir: string;
  rendererMic: boolean;
  warnings: string[];
}
