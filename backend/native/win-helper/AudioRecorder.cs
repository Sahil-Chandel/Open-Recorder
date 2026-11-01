using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace WinHelper;

/// <summary>
/// WASAPI capture → WAV (tasks 1.12, 1.13). Loopback for system audio, shared-mode capture for the mic.
/// Loopback delivers no packets while nothing plays, so silence is inserted against the wall clock to keep
/// the track aligned with video. WAV header is flushed every second (crash safety).
/// </summary>
public sealed class AudioRecorder : IDisposable
{
    private readonly IWaveIn _capture;
    private readonly WaveFileWriter _writer;
    private readonly object _lock = new();
    private readonly System.Threading.Timer _gapTimer;
    private long _startNs = -1;
    private long _framesWritten;
    private readonly int _bytesPerFrame;
    private readonly int _rate;
    private readonly bool _fillGaps;
    private float _peak;
    private long _lastFlush;
    private bool _closed; // guarded by _lock: set once Stop() finalised the file; late callbacks become no-ops
    public string File { get; }
    public long StartNs => _startNs;
    public string Kind { get; }
    /// <summary>Mic mute from the control bar: keeps the timeline but writes silence.</summary>
    public bool Muted { get; set; }

    private AudioRecorder(IWaveIn capture, string file, bool fillGaps, string kind)
    {
        _capture = capture;
        File = file;
        Kind = kind;
        _fillGaps = fillGaps;
        _writer = new WaveFileWriter(file, capture.WaveFormat);
        _bytesPerFrame = capture.WaveFormat.BlockAlign;
        _rate = capture.WaveFormat.SampleRate;
        _capture.DataAvailable += OnData;
        _capture.RecordingStopped += (_, e) => { if (e.Exception is not null) Rpc.Log("error", $"audio.{kind}.stopped", null, e.Exception); };
        _gapTimer = new System.Threading.Timer(_ => FillGap(), null, Timeout.Infinite, Timeout.Infinite);
    }

    public static AudioRecorder SystemLoopback(string file, string? deviceId, int? appPid = null)
    {
        if (appPid is > 0)
        {
            try { return new AudioRecorder(ProcessLoopbackCapture.Create(appPid.Value), file, fillGaps: true, "system"); }
            catch (Exception ex) { Rpc.Log("warn", "audio.processLoopback.fallback", new { appPid }, ex); Rpc.Notify("error", new { source = "systemAudio", message = "Per-app audio is not supported on this Windows version — recording all system audio instead." }); }
        }
        using var en = new MMDeviceEnumerator();
        var dev = deviceId is { Length: > 0 } ? en.GetDevice(deviceId) : en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
        return new AudioRecorder(new WasapiLoopbackCapture(dev), file, fillGaps: true, "system");
    }

    public static AudioRecorder Microphone(string file, string? deviceId)
    {
        using var en = new MMDeviceEnumerator();
        var dev = deviceId is { Length: > 0 } ? en.GetDevice(deviceId) : en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        return new AudioRecorder(new WasapiCapture(dev, true, 20), file, fillGaps: true, "mic");
    }

    /// <param name="sessionT0Ns">QPC ns of the recording session's t0</param>
    public void Start(long segmentStartNs)
    {
        _startNs = segmentStartNs;
        _capture.StartRecording();
        _gapTimer.Change(100, 100);
    }

    private long ExpectedFrames() => (long)((WgcCapture.QpcNowNs() - _startNs) / 1e9 * _rate);

    private void OnData(object? sender, WaveInEventArgs e)
    {
        lock (_lock)
        {
            if (_closed) return;
            // packets cover [now - len, now]; if we're behind the wall clock by more than this packet, pad first
            var frames = e.BytesRecorded / _bytesPerFrame;
            var behind = ExpectedFrames() - frames - _framesWritten;
            if (_fillGaps && behind > _rate / 20) WriteSilence(behind);
            if (Muted) WriteSilence(frames); // advances _framesWritten itself
            else
            {
                _writer.Write(e.Buffer, 0, e.BytesRecorded);
                _framesWritten += frames;
                _peak = Math.Max(_peak, Peak(e.Buffer, e.BytesRecorded));
            }
            var now = Environment.TickCount64;
            if (now - _lastFlush > 1000) { _writer.Flush(); _lastFlush = now; }
        }
    }

    // Timer callback on the thread pool: an escaping exception would terminate the helper.
    private void FillGap()
    {
        if (!_fillGaps) return;
        try
        {
            lock (_lock)
            {
                if (_closed) return;
                var behind = ExpectedFrames() - _framesWritten;
                if (behind > _rate / 5) WriteSilence(behind - _rate / 20); // leave headroom for an in-flight packet
            }
        }
        catch (Exception ex) { Rpc.Log("error", $"audio.{Kind}.gapFill", null, ex); }
    }

    private void WriteSilence(long frames)
    {
        var bytes = new byte[Math.Min(frames, _rate) * _bytesPerFrame];
        while (frames > 0)
        {
            var n = (int)Math.Min(frames, _rate);
            _writer.Write(bytes, 0, n * _bytesPerFrame);
            _framesWritten += n;
            frames -= n;
        }
    }

    private float Peak(byte[] buf, int len)
    {
        var fmt = _capture.WaveFormat;
        float peak = 0;
        if (fmt.Encoding == WaveFormatEncoding.IeeeFloat || (fmt is WaveFormatExtensible && fmt.BitsPerSample == 32))
            for (var i = 0; i + 4 <= len; i += 16) peak = Math.Max(peak, Math.Abs(BitConverter.ToSingle(buf, i)));
        else if (fmt.BitsPerSample == 16)
            for (var i = 0; i + 2 <= len; i += 8) peak = Math.Max(peak, Math.Abs(BitConverter.ToInt16(buf, i) / 32768f));
        return peak;
    }

    /// <summary>Peak since last call (0..1) for 20 Hz level meters.</summary>
    public float TakePeak()
    {
        lock (_lock) { var p = _peak; _peak = 0; return p; }
    }

    public void Stop()
    {
        _gapTimer.Change(Timeout.Infinite, Timeout.Infinite);
        try { _capture.StopRecording(); } catch (Exception ex) { Rpc.Log("warn", $"audio.{Kind}.stop", null, ex); }
        Thread.Sleep(60);
        lock (_lock)
        {
            if (_closed) return;
            if (_fillGaps) { var behind = ExpectedFrames() - _framesWritten; if (behind > 0) WriteSilence(behind); }
            _writer.Flush();
            _closed = true;
        }
    }

    public void Dispose()
    {
        _gapTimer.Dispose();
        // capture first: NAudio joins its capture thread, so no DataAvailable can race the writer disposal
        try { _capture.Dispose(); } catch (Exception ex) { Rpc.Log("warn", $"audio.{Kind}.dispose", null, ex); }
        lock (_lock)
        {
            _closed = true;
            _writer.Dispose();
        }
    }
}

/// <summary>Level meter only (recorder window, task 2.1): captures without writing to disk.</summary>
public sealed class LevelMonitor : IDisposable
{
    private readonly List<WasapiCapture> _caps = [];
    private float _mic, _sys;
    private readonly System.Threading.Timer _timer;

    public LevelMonitor(string? micId, string? outId)
    {
        using var en = new MMDeviceEnumerator();
        try
        {
            var mic = micId is { Length: > 0 } ? en.GetDevice(micId) : en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            var c = new WasapiCapture(mic, true, 50);
            c.DataAvailable += (_, e) => _mic = Math.Max(_mic, PeakF(c.WaveFormat, e));
            c.StartRecording();
            _caps.Add(c);
        }
        catch (Exception ex) { Rpc.Log("warn", "levels.mic", null, ex); }
        try
        {
            var outDev = outId is { Length: > 0 } ? en.GetDevice(outId) : en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var c = new WasapiLoopbackCapture(outDev);
            c.DataAvailable += (_, e) => _sys = Math.Max(_sys, PeakF(c.WaveFormat, e));
            c.StartRecording();
            _caps.Add(c);
        }
        catch (Exception ex) { Rpc.Log("warn", "levels.system", null, ex); }
        _timer = new System.Threading.Timer(_ => { Rpc.Notify("levels", new { mic = _mic, system = _sys }); _mic = 0; _sys = 0; }, null, 50, 50);
    }

    private static float PeakF(WaveFormat fmt, WaveInEventArgs e)
    {
        float p = 0;
        if (fmt.BitsPerSample == 32) for (var i = 0; i + 4 <= e.BytesRecorded; i += 16) p = Math.Max(p, Math.Abs(BitConverter.ToSingle(e.Buffer, i)));
        else if (fmt.BitsPerSample == 16) for (var i = 0; i + 2 <= e.BytesRecorded; i += 8) p = Math.Max(p, Math.Abs(BitConverter.ToInt16(e.Buffer, i) / 32768f));
        return p;
    }

    public void Dispose()
    {
        _timer.Dispose();
        foreach (var c in _caps) { try { c.StopRecording(); c.Dispose(); } catch { /* device gone */ } }
    }
}
