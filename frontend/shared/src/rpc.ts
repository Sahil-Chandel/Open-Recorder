/**
 * Native helper protocol (plan §1.1): JSON-RPC 2.0 over stdio, one JSON object per line.
 * Shared by the Electron HelperSupervisor and documented for the C#/Swift helpers.
 */
import { z } from 'zod';

export const RpcRequestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), method: z.string(), params: z.unknown().optional() });
export const RpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
export const RpcNotificationSchema = z.object({ jsonrpc: z.literal('2.0'), method: z.string(), params: z.unknown().optional() });

export const DisplayInfoSchema = z.object({ id: z.string(), name: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), scaleFactor: z.number(), primary: z.boolean(), index: z.number() });
export type DisplayInfo = z.infer<typeof DisplayInfoSchema>;
export const WindowInfoSchema = z.object({ id: z.string(), title: z.string(), app: z.string(), pid: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type WindowInfo = z.infer<typeof WindowInfoSchema>;
export const AudioDeviceSchema = z.object({ id: z.string(), name: z.string(), isDefault: z.boolean() });
export type AudioDevice = z.infer<typeof AudioDeviceSchema>;
export const AudioAppSchema = z.object({ pid: z.number(), name: z.string() });
export type AudioApp = z.infer<typeof AudioAppSchema>;

export const RecordingConfigSchema = z.object({
  bundleDir: z.string(),
  mode: z.enum(['display', 'window', 'area']),
  displayId: z.string(),
  windowId: z.string().optional(),
  area: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  fps: z.number().int().min(10).max(120),
  quality: z.enum(['low', 'medium', 'high', 'lossless']),
  encoder: z.enum(['auto', 'nvenc', 'qsv', 'amf', 'x264', 'videotoolbox']).default('auto'),
  systemAudio: z.object({ enabled: z.boolean(), deviceId: z.string().optional(), appPid: z.number().optional() }),
  mic: z.object({ enabled: z.boolean(), deviceId: z.string().optional() }),
  captureInput: z.boolean(),
  excludePids: z.array(z.number()).default([]),
});
export type RecordingConfig = z.infer<typeof RecordingConfigSchema>;

export const RecordingStatusSchema = z.object({
  state: z.enum(['idle', 'recording', 'paused', 'stopping', 'error']),
  segment: z.number(),
  elapsedNs: z.number(),
  droppedFrames: z.number(),
  bytesWritten: z.number(),
});
export type RecordingStatus = z.infer<typeof RecordingStatusSchema>;

export const StopResultSchema = z.object({
  segments: z.array(z.object({ file: z.string(), startNs: z.number(), durationNs: z.number() })),
  audio: z.object({ mic: z.array(z.string()), system: z.array(z.string()) }),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  scaleFactor: z.number(),
});
export type StopResult = z.infer<typeof StopResultSchema>;

export const LevelsSchema = z.object({ mic: z.number(), system: z.number() });

export const HELPER_METHODS = ['ping', 'version', 'listDisplays', 'listWindows', 'listAudioInputs', 'listAudioOutputs', 'listAudioApps', 'startRecording', 'pause', 'resume', 'stop', 'status', 'setDesktopClean', 'copyFileToClipboard', 'windowThumbnail', 'startLevels', 'stopLevels'] as const;
export type HelperMethod = (typeof HELPER_METHODS)[number];