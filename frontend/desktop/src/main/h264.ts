/**
 * H.264 encoder selection for ffmpeg jobs (sample project, video import). Shipped builds use an LGPL ffmpeg,
 * which has no libx264 — so hardware / OS encoders are probed first and libx264 is only one candidate.
 * The first encoder that completes a tiny synthetic encode wins and is cached for the session.
 */
import { runFfmpeg } from './projects';
import { logger } from './log';

const log = logger.child('h264');

const CANDIDATES: Array<{ name: string; args: (crf: number) => string[] }> = [
  { name: 'libx264', args: (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf)] },
  { name: 'h264_nvenc', args: (crf) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', String(crf + 2), '-b:v', '0'] },
  { name: 'h264_qsv', args: (crf) => ['-c:v', 'h264_qsv', '-global_quality', String(crf + 2)] },
  { name: 'h264_amf', args: (crf) => ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf + 2), '-qp_p', String(crf + 4)] },
  { name: 'h264_mf', args: () => ['-c:v', 'h264_mf', '-b:v', '8M'] }, // Windows Media Foundation (in every Windows ffmpeg build)
  { name: 'h264_videotoolbox', args: () => ['-c:v', 'h264_videotoolbox', '-b:v', '8M'] },
  { name: 'libopenh264', args: () => ['-c:v', 'libopenh264', '-b:v', '8M'] },
];

let picked: Promise<(typeof CANDIDATES)[number]> | null = null;

export function pickH264(): Promise<(typeof CANDIDATES)[number]> {
  picked ??= (async () => {
    for (const c of CANDIDATES) {
      try {
        await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=0.2', ...c.args(23), '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
        log.info('h264.picked', { encoder: c.name });
        return c;
      } catch {
        /* not in this ffmpeg build / no hardware — try the next one */
      }
    }
    throw new Error('No H.264 encoder is available in this ffmpeg build');
  })();
  picked.catch(() => (picked = null)); // retry next time (e.g. driver installed)
  return picked;
}

/** ffmpeg args for an H.264 encode at roughly the given CRF quality, with the yuv420p + faststart basics. */
export async function h264Args(crf = 20): Promise<string[]> {
  const c = await pickH264();
  return [...c.args(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
}
