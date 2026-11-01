import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureError, acquireSources, describeMediaError, extensionFor, pickMime, recordingName, videoBitrate } from './media';

const err = (name: string, message = '') => Object.assign(new Error(message), { name });
const track = (kind: 'audio' | 'video') => ({ kind, stop: vi.fn() }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) => ({
  getTracks: () => tracks,
  getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
}) as unknown as MediaStream;

interface Env { gum: ReturnType<typeof vi.fn>; gdm?: ReturnType<typeof vi.fn>; perms?: Record<string, PermissionState> }
function env({ gum, gdm, perms = {} }: Env) {
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: gum, ...(gdm ? { getDisplayMedia: gdm } : {}) },
    permissions: { query: async ({ name }: { name: string }) => ({ state: perms[name] ?? 'prompt' }) },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('describeMediaError', () => {
  it('distinguishes a site block from an OS privacy block', () => {
    expect(describeMediaError(err('NotAllowedError', 'Permission denied'), 'microphone')).toMatch(/address bar/);
    expect(describeMediaError(err('NotAllowedError', 'Permission denied by system'), 'camera')).toMatch(/system’s privacy settings/);
  });

  it('explains missing and busy devices', () => {
    expect(describeMediaError(err('NotFoundError'), 'camera')).toBe('No camera was found. Connect one and try again.');
    expect(describeMediaError(err('NotReadableError'), 'microphone')).toMatch(/another app may be using it/);
  });

  it('treats a closed screen picker as a cancellation, not a failure', () => {
    expect(describeMediaError(err('NotAllowedError', 'Permission denied'), 'screen')).toBe('Screen sharing was cancelled.');
    expect(describeMediaError(err('NotAllowedError', 'Permission denied by system'), 'screen')).toMatch(/Screen Recording/);
  });

  it('falls back to the browser message', () => {
    expect(describeMediaError(err('WeirdError', 'boom'), 'camera')).toBe('Camera couldn’t start: boom');
    expect(describeMediaError(null, 'camera')).toBe('Camera couldn’t start.');
  });
});

describe('acquireSources', () => {
  it('fails loudly when the microphone is required (mic recorder) and blocked', async () => {
    env({ gum: vi.fn().mockRejectedValue(err('NotAllowedError', 'Permission denied')) });
    await expect(acquireSources({ screen: false, camera: false, mic: true }, { camera: false, mic: true })).rejects.toBeInstanceOf(CaptureError);
  });

  it('salvages the microphone when only the camera is missing, and warns about the camera', async () => {
    const mic = track('audio');
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      if (c.video) throw err('NotFoundError', 'Requested device not found');
      return stream(mic);
    });
    env({ gum });
    const s = await acquireSources({ screen: false, camera: true, mic: true }, { camera: false, mic: false });
    expect(s.mic).toBe(mic);
    expect(s.camera).toBeNull();
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/without the camera.*No camera was found/);
  });

  it('does not re-prompt after the user refused, but reports both devices', async () => {
    const gum = vi.fn().mockRejectedValue(err('NotAllowedError', 'Permission denied'));
    env({ gum, perms: { camera: 'prompt', microphone: 'prompt' } });
    const s = await acquireSources({ screen: false, camera: true, mic: true }, { camera: false, mic: false });
    expect(gum).toHaveBeenCalledTimes(1);
    expect(s.warnings.join(' ')).toMatch(/without the camera/);
    expect(s.warnings.join(' ')).toMatch(/voice won’t be recorded/);
  });

  it('retries a device that is still granted after an OS-level block of the other one', async () => {
    const mic = track('audio');
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      if (c.video) throw err('NotAllowedError', 'Permission denied by system');
      return stream(mic);
    });
    env({ gum, perms: { camera: 'granted', microphone: 'granted' } });
    const s = await acquireSources({ screen: false, camera: true, mic: true }, { camera: false, mic: false });
    expect(s.mic).toBe(mic);
    expect(s.warnings[0]).toMatch(/privacy settings/);
  });

  it('stops already-captured tracks when a required camera fails', async () => {
    const screenTrack = track('video');
    const gdm = vi.fn().mockResolvedValue(stream(screenTrack));
    env({ gdm, gum: vi.fn().mockRejectedValue(err('NotReadableError')) });
    await expect(acquireSources({ screen: true, camera: true, mic: false }, { camera: true, mic: false })).rejects.toThrow(/couldn’t be started/);
    expect(screenTrack.stop).toHaveBeenCalled();
  });

  it('marks a closed share picker as cancelled', async () => {
    env({ gdm: vi.fn().mockRejectedValue(err('NotAllowedError', 'Permission denied')), gum: vi.fn() });
    const e = await acquireSources({ screen: true, camera: false, mic: true }, { camera: false, mic: false }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CaptureError);
    expect((e as CaptureError).cancelled).toBe(true);
  });

  it('records the screen with a mic warning when the microphone is unavailable', async () => {
    const screenTrack = track('video');
    env({ gdm: vi.fn().mockResolvedValue(stream(screenTrack)), gum: vi.fn().mockRejectedValue(err('NotFoundError')) });
    const s = await acquireSources({ screen: true, camera: false, mic: true }, { camera: false, mic: false });
    expect(s.display).not.toBeNull();
    expect(s.mic).toBeNull();
    expect(s.warnings).toEqual(['Your voice won’t be recorded. No microphone was found. Connect one and try again.']);
    s.stop();
    expect(screenTrack.stop).toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('picks the first supported MIME type for the track mix', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (m: string) => m === 'video/webm;codecs=vp8' || m === 'video/webm;codecs=vp8,opus' || m === 'audio/webm' });
    expect(pickMime(true, true)).toBe('video/webm;codecs=vp8,opus');
    expect(pickMime(true, false)).toBe('video/webm;codecs=vp8');
    expect(pickMime(false, true)).toBe('audio/webm');
  });

  it('maps MIME types to file extensions', () => {
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(extensionFor('video/mp4')).toBe('mp4');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('audio/ogg;codecs=opus')).toBe('ogg');
  });

  it('scales the bitrate with resolution within sane bounds', () => {
    expect(videoBitrate({ w: 640, h: 360 })).toBe(2_500_000);
    expect(videoBitrate({ w: 1920, h: 1080 })).toBe(7_464_960);
    expect(videoBitrate({ w: 5120, h: 2880 })).toBe(16_000_000);
  });

  it('names downloads with a sortable timestamp', () => {
    expect(recordingName('mp4', new Date(2026, 9, 30, 9, 5))).toBe('recording-2026-10-30-0905.mp4');
  });
});
