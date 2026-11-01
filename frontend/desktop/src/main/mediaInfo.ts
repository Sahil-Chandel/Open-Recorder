/**
 * Media info from `ffmpeg -i <file>` (stderr), shaped like the subset of `ffprobe -print_format json` the app
 * reads (format.duration; streams[].codec_type / codec_name / width / height / avg_frame_rate). Installers
 * bundle only ffmpeg, so ffprobe — another ~230 MB — is optional.
 */
export interface MediaInfo {
  streams: Array<Record<string, unknown>>;
  format: Record<string, unknown>;
}

export function parseFfmpegInfo(stderr: string): MediaInfo {
  const format: Record<string, unknown> = {};
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) format.duration = String(Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]));
  const streams: Array<Record<string, unknown>> = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /^\s*Stream #\d+:\d+.*?:\s*(Video|Audio|Subtitle|Data):\s*([A-Za-z0-9_]+)/.exec(line);
    if (!m) continue;
    const s: Record<string, unknown> = { codec_type: m[1]!.toLowerCase(), codec_name: m[2] };
    if (s.codec_type === 'video') {
      const size = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(line);
      if (size) { s.width = Number(size[1]); s.height = Number(size[2]); }
      const fps = /,\s*([\d.]+)\s*fps/.exec(line) ?? /,\s*([\d.]+)\s*tbr/.exec(line);
      if (fps) s.avg_frame_rate = `${Math.round(Number(fps[1]) * 1000)}/1000`;
    }
    streams.push(s);
  }
  return { streams, format };
}
