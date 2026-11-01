using System.Text.Json;
using System.Text.Json.Nodes;

namespace WinHelper;

public record AreaRect(int X, int Y, int Width, int Height);
public record SystemAudioCfg(bool Enabled, string? DeviceId, int? AppPid);
public record MicCfg(bool Enabled, string? DeviceId);
public record RecordingConfig(
    string BundleDir, string Mode, string DisplayId, string? WindowId, AreaRect? Area, int Fps, string Quality, string Encoder,
    SystemAudioCfg SystemAudio, MicCfg Mic, bool CaptureInput, int[]? ExcludePids);

public record SegmentInfo(string File, long StartNs, long DurationNs);

/// <summary>
/// One recording (tasks 1.17â€“1.19): segments on pause/resume, recording.lock + segments.json for crash
/// recovery, disk monitor. All timestamps are ns since the session t0 (QPC) â€” one clock for every track.
/// </summary>
public sealed class RecordingSession : IDisposable
{
    private readonly RecordingConfig _cfg;
    private readonly long _t0;
    private readonly WgcCapture _capture;
    private readonly InputRecorder? _input;
    private readonly (int x, int y) _monitorOrigin;
    private readonly IntPtr _hwnd;
    private readonly List<SegmentInfo> _segments = [];
    private readonly List<string> _micFiles = [], _sysFiles = [];
    private FfmpegEncoder? _encoder;
    private AudioRecorder? _mic, _sys;
    private Thread? _pump;
    private volatile bool _pumping;
    private long _segStartNs;
    private long _segFrames;
    private readonly System.Threading.Timer _monitor;
    private bool _diskWarned;
    public string State { get; private set; } = "idle";
    private bool _micMuted;
    public void SetMicMuted(bool muted) { _micMuted = muted; if (_mic is not null) _mic.Muted = muted; }
    public void SetKeysPaused(bool paused) { if (_input is not null) _input.KeysPaused = paused; }
    public long DroppedFrames { get; private set; }
    public double ScaleFactor { get; }

    public RecordingSession(RecordingConfig cfg)
    {
        _cfg = cfg;
        Directory.CreateDirectory(Path.Combine(cfg.BundleDir, "media"));
        Directory.CreateDirectory(Path.Combine(cfg.BundleDir, "events"));
        var displays = Enumeration.ListDisplays();
        var disp = displays.FirstOrDefault(d => d.Id == cfg.DisplayId) ?? displays.FirstOrDefault(d => d.Primary) ?? displays[0];
        ScaleFactor = disp.ScaleFactor;
        _monitorOrigin = (disp.X, disp.Y);
        var hmon = new IntPtr(long.Parse(disp.Id));
        switch (cfg.Mode)
        {
            case "window":
                _hwnd = new IntPtr(long.Parse(cfg.WindowId ?? throw new RpcException(-32602, "windowId required")));
                _capture = WgcCapture.ForWindow(_hwnd);
                break;
            case "area":
                var a = cfg.Area ?? throw new RpcException(-32602, "area required");
                _monitorOrigin = (disp.X + Math.Max(0, a.X - disp.X), disp.Y + Math.Max(0, a.Y - disp.Y));
                _capture = WgcCapture.ForMonitor(hmon, (a.X - disp.X, a.Y - disp.Y, a.Width, a.Height));
                break;
            default:
                _capture = WgcCapture.ForMonitor(hmon);
                break;
        }
        _t0 = WgcCapture.QpcNowNs();
        File.WriteAllText(Path.Combine(cfg.BundleDir, "recording.lock"),
            JsonSerializer.Serialize(new { pid = Environment.ProcessId, startedAt = DateTime.UtcNow.ToString("O"), t0Ns = _t0 }));
        if (cfg.CaptureInput)
            _input = new InputRecorder(Path.Combine(cfg.BundleDir, "events"), _t0, Origin);
        _monitor = new System.Threading.Timer(_ => CheckDisk(), null, 5000, 5000);
    }

    private (int x, int y) Origin()
    {
        if (_hwnd != IntPtr.Zero) { var r = Enumeration.WindowBounds(_hwnd); return (r.Left, r.Top); }
        return _monitorOrigin;
    }

    private long Now() => WgcCapture.QpcNowNs() - _t0;

    public void Start()
    {
        _capture.Start();
        _input?.Start();
        // wait for the first frame (â‰¤ 2 s) so segment 0 starts with real content
        var deadline = Environment.TickCount64 + 2000;
        var probe = new byte[_capture.Width * _capture.Height * 4];
        while (!_capture.CopyLatest(probe) && Environment.TickCount64 < deadline) Thread.Sleep(5);
        BeginSegment();
        State = "recording";
    }

    private void BeginSegment()
    {
        var idx = _segments.Count;
        var file = $"media/screen_{idx:000}.mp4";
        _encoder = new FfmpegEncoder(Path.Combine(_cfg.BundleDir, file), _capture.Width, _capture.Height, _cfg.Fps, _cfg.Quality, _cfg.Encoder);
        _segStartNs = Now();
        _segFrames = 0;
        var absStart = _t0 + _segStartNs;
        if (_cfg.SystemAudio.Enabled)
        {
            try
            {
                var f = $"media/system_{idx:000}.wav";
                _sys = AudioRecorder.SystemLoopback(Path.Combine(_cfg.BundleDir, f), _cfg.SystemAudio.DeviceId, _cfg.SystemAudio.AppPid);
                _sys.Start(absStart);
                _sysFiles.Add(f);
            }
            catch (Exception ex) { Rpc.Log("error", "session.systemAudio", null, ex); Rpc.Notify("error", new { source = "systemAudio", message = ex.Message }); }
        }
        if (_cfg.Mic.Enabled)
        {
            try
            {
                var f = $"media/mic_{idx:000}.wav";
                _mic = AudioRecorder.Microphone(Path.Combine(_cfg.BundleDir, f), _cfg.Mic.DeviceId);
                _mic.Muted = _micMuted;
                _mic.Start(absStart);
                _micFiles.Add(f);
            }
            catch (Exception ex) { Rpc.Log("error", "session.mic", null, ex); Rpc.Notify("error", new { source = "mic", message = ex.Message }); }
        }
        _segments.Add(new SegmentInfo(file, _segStartNs, 0));
        WriteSegmentsJournal();
        _pumping = true;
        _pump = new Thread(Pump) { IsBackground = true, Name = "frame-pump", Priority = ThreadPriority.AboveNormal };
        _pump.Start();
        if (_input is not null) _input.Paused = false;
    }

    /// <summary>CFR pump: frame i is due at segStart + i/fps. Late â†’ duplicate frames to stay in sync with audio.</summary>
    private void Pump()
    {
        Native.timeBeginPeriod(1);
        var buf = new byte[_capture.Width * _capture.Height * 4];
        var lastLevel = 0L;
        try
        {
            while (_pumping)
            {
                var due = (long)((Now() - _segStartNs) / 1e9 * _cfg.Fps) + 1;
                if (due > _segFrames)
                {
                    _capture.CopyLatest(buf);
                    var burst = 0;
                    while (_segFrames < due && burst < 10 && _pumping)
                    {
                        try { _encoder!.Write(buf); }
                        catch (IOException ex) { Rpc.Log("error", "pump.write", null, ex); Rpc.Notify("error", new { source = "encoder", message = "encoder stopped" }); _pumping = false; break; }
                        _segFrames++; burst++;
                    }
                    if (due - _segFrames > _cfg.Fps / 2) { DroppedFrames += due - _segFrames; Rpc.Notify("frameDrop", new { behind = due - _segFrames }); _segFrames = due; }
                }
                var now = Environment.TickCount64;
                if (now - lastLevel >= 50)
                {
                    lastLevel = now;
                    Rpc.Notify("levels", new { mic = _mic?.TakePeak() ?? 0, system = _sys?.TakePeak() ?? 0 });
                }
                var nextDueNs = _segStartNs + (long)(_segFrames * 1e9 / _cfg.Fps);
                var sleepMs = (nextDueNs - Now()) / 1_000_000;
                if (sleepMs > 1) Thread.Sleep((int)Math.Min(sleepMs - 1, 20));
            }
        }
        finally { Native.timeEndPeriod(1); }
    }

    private void EndSegment()
    {
        _pumping = false;
        _pump?.Join(3000);
        if (_input is not null) _input.Paused = true;
        // stop audio first so its length matches the video frames written (encoder finalisation can take seconds)
        _mic?.Stop(); _mic?.Dispose(); _mic = null;
        _sys?.Stop(); _sys?.Dispose(); _sys = null;
        _encoder?.Finish();
        _encoder?.Dispose();
        _encoder = null;
        var last = _segments[^1];
        _segments[^1] = last with { DurationNs = (long)(_segFrames * 1e9 / _cfg.Fps) };
        WriteSegmentsJournal();
    }

    private void WriteSegmentsJournal()
    {
        var node = new JsonObject
        {
            ["segments"] = JsonSerializer.SerializeToNode(_segments, Rpc.Json),
            ["mic"] = JsonSerializer.SerializeToNode(_micFiles), ["system"] = JsonSerializer.SerializeToNode(_sysFiles),
            ["width"] = _capture.Width, ["height"] = _capture.Height, ["fps"] = _cfg.Fps, ["scaleFactor"] = ScaleFactor,
        };
        var tmp = Path.Combine(_cfg.BundleDir, "segments.json.tmp");
        File.WriteAllText(tmp, node.ToJsonString());
        File.Move(tmp, Path.Combine(_cfg.BundleDir, "segments.json"), true);
    }

    public void Pause()
    {
        if (State != "recording") throw new RpcException(-32020, $"cannot pause in state {State}");
        EndSegment();
        State = "paused";
    }

    public void Resume()
    {
        if (State != "paused") throw new RpcException(-32020, $"cannot resume in state {State}");
        BeginSegment();
        State = "recording";
    }

    public object Stop()
    {
        if (State == "recording") EndSegment();
        State = "stopping";
        _input?.Stop();
        _capture.Dispose();
        State = "idle";
        return new
        {
            segments = _segments,
            audio = new { mic = _micFiles, system = _sysFiles },
            width = _capture.Width, height = _capture.Height, fps = _cfg.Fps, scaleFactor = ScaleFactor,
        };
    }

    public object Status() => new
    {
        state = State,
        segment = _segments.Count - 1,
        elapsedNs = _segments.Take(Math.Max(0, _segments.Count - 1)).Sum(s => s.DurationNs) + (State == "recording" ? Now() - _segStartNs : 0),
        droppedFrames = DroppedFrames,
        bytesWritten = SafeSize(),
    };

    private long SafeSize()
    {
        try { return new DirectoryInfo(Path.Combine(_cfg.BundleDir, "media")).EnumerateFiles().Sum(f => f.Length); }
        catch { return 0; }
    }

    private void CheckDisk()
    {
        try
        {
            var free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(_cfg.BundleDir))!).AvailableFreeSpace;
            if (free < 500L * 1024 * 1024 && State == "recording")
            {
                Rpc.Notify("diskLow", new { freeBytes = free, action = "stop" });
            }
            else if (free < 2L * 1024 * 1024 * 1024 && !_diskWarned)
            {
                _diskWarned = true;
                Rpc.Notify("diskLow", new { freeBytes = free, action = "warn" });
            }
        }
        catch (Exception ex) { Rpc.Log("warn", "session.disk", null, ex); }
    }

    public void Dispose()
    {
        _monitor.Dispose();
        if (State is "recording" or "paused") { try { Stop(); } catch (Exception ex) { Rpc.Log("error", "session.dispose", null, ex); } }
        _input?.Dispose();
    }
}
