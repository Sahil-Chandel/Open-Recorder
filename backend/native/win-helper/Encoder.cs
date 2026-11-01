using System.Diagnostics;

namespace WinHelper;

/// <summary>
/// ffmpeg encoder process fed raw BGRA frames over stdin (task 1.11). Hardware H.264 when available
/// (NVENC → AMF → QSV → Media Foundation), libx264 last: shipped LGPL ffmpeg builds have no libx264, while
/// h264_mf is in every Windows build. Output is fragmented MP4 (2 s fragments) so a crash loses ≤ ~2 s.
/// </summary>
public sealed class FfmpegEncoder : IDisposable
{
    private static string? _probed;
    private static readonly object ProbeLock = new();
    private readonly Process _proc;
    private readonly Stream _stdin;
    public string Codec { get; }
    public long FramesWritten { get; private set; }

    public static string FfmpegPath =>
        Environment.GetEnvironmentVariable("RECORDER_FFMPEG") is { Length: > 0 } p && File.Exists(p) ? p : "ffmpeg";

    /// <summary>Probe hardware encoders once with a tiny synthetic encode; cache the winner.</summary>
    public static string ProbeEncoder(string preference)
    {
        if (preference is "nvenc" or "amf" or "qsv" or "mf" or "x264") return preference;
        lock (ProbeLock)
        {
            if (_probed is not null) return _probed;
            foreach (var cand in new[] { "nvenc", "amf", "qsv", "mf" })
            {
                var psi = new ProcessStartInfo(FfmpegPath,
                    $"-hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -frames:v 5 -c:v {CodecName(cand)} -f null -")
                { RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true };
                try
                {
                    using var p = Process.Start(psi)!;
                    if (!p.WaitForExit(8000)) { p.Kill(); continue; }
                    if (p.ExitCode == 0) { _probed = cand; break; }
                }
                catch (Exception ex) { Rpc.Log("warn", "encoder.probe", new { cand }, ex); }
            }
            _probed ??= "x264";
            Rpc.Log("info", "encoder.probe", new { selected = _probed });
            return _probed;
        }
    }

    private static string CodecName(string enc) => enc switch
    {
        "nvenc" => "h264_nvenc",
        "amf" => "h264_amf",
        "qsv" => "h264_qsv",
        "mf" => "h264_mf",
        _ => "libx264",
    };

    private static string QualityArgs(string enc, string quality)
    {
        var cq = quality switch { "low" => 30, "medium" => 26, "lossless" => 16, _ => 22 };
        return enc switch
        {
            "nvenc" => $"-preset p4 -tune hq -rc vbr -cq {cq} -b:v 0",
            "amf" => $"-quality balanced -rc cqp -qp_i {cq} -qp_p {cq + 2}",
            "qsv" => $"-preset medium -global_quality {cq}",
            "mf" => $"-rate_control quality -quality {Math.Clamp(100 - cq * 2, 40, 95)} -scenario display_remoting",
            _ => $"-preset veryfast -crf {cq - 2} -tune zerolatency",
        };
    }

    public FfmpegEncoder(string outFile, int width, int height, int fps, string quality, string encoderPref)
    {
        Codec = ProbeEncoder(encoderPref);
        var gop = fps * 2;
        var args =
            $"-hide_banner -loglevel warning -y -f rawvideo -pix_fmt bgra -s {width}x{height} -framerate {fps} -i pipe:0 " +
            $"-c:v {CodecName(Codec)} {QualityArgs(Codec, quality)} -pix_fmt yuv420p -g {gop} -bf 0 " +
            $"-movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 \"{outFile}\"";
        var psi = new ProcessStartInfo(FfmpegPath, args)
        {
            RedirectStandardInput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true,
        };
        _proc = Process.Start(psi) ?? throw new RpcException(-32010, "failed to start ffmpeg");
        _proc.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) Rpc.Log("warn", "ffmpeg.stderr", new { line = e.Data }); };
        _proc.BeginErrorReadLine();
        _stdin = _proc.StandardInput.BaseStream;
        Rpc.Log("info", "encoder.start", new { outFile, width, height, fps, codec = Codec });
    }

    public bool HasExited => _proc.HasExited;

    public void Write(byte[] frame)
    {
        _stdin.Write(frame, 0, frame.Length);
        FramesWritten++;
    }

    /// <summary>Close stdin so ffmpeg finalises the file; wait up to timeout.</summary>
    public void Finish(int timeoutMs = 20000)
    {
        try { _stdin.Flush(); _stdin.Close(); } catch (IOException) { /* ffmpeg already gone */ }
        if (!_proc.WaitForExit(timeoutMs))
        {
            Rpc.Log("warn", "encoder.finish", new { note = "timeout, killing" });
            try { _proc.Kill(); } catch { /* exited */ }
        }
    }

    public void Dispose()
    {
        if (!_proc.HasExited) Finish(5000);
        _proc.Dispose();
    }
}
