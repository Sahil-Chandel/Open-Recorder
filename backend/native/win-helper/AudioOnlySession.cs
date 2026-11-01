using System.Text.Json.Serialization;

namespace WinHelper;

/// <summary>startAudioCapture params: bundle dir + the same per-source configs a screen recording takes.</summary>
public record AudioCaptureConfig(string Dir, [property: JsonPropertyName("system")] SystemAudioCfg? SystemAudio, MicCfg? Mic);

/// <summary>
/// Audio-only capture for device (Android) recordings, DEV-03: the PC's system audio (loopback, optionally one
/// app) and/or mic → media/system.wav, media/mic.wav. Both recorders start on one QPC t0, so the caller maps a
/// single start time onto its own clock (Electron aligns them to the phone's first video frame). AudioRecorder
/// pads silence from t0 until each device delivers and flushes the WAV header every second, so the files have
/// the same alignment and crash safety as a screen take's. The caller owns the bundle (lock, journal).
/// </summary>
public sealed class AudioOnlySession : IDisposable
{
    private AudioRecorder? _sys, _mic;
    private readonly List<object> _errors = [];
    private long _stoppedNs;
    public string State { get; private set; } = "idle";
    public long T0Ns { get; private set; }

    public AudioOnlySession(AudioCaptureConfig cfg)
    {
        var media = Path.Combine(cfg.Dir, "media");
        Directory.CreateDirectory(media);
        if (cfg.SystemAudio is { Enabled: true } sys)
        {
            try { _sys = AudioRecorder.SystemLoopback(Path.Combine(media, "system.wav"), sys.DeviceId, sys.AppPid); }
            catch (Exception ex) { Fail("systemAudio", ex); }
        }
        if (cfg.Mic is { Enabled: true } mic)
        {
            try { _mic = AudioRecorder.Microphone(Path.Combine(media, "mic.wav"), mic.DeviceId); }
            catch (Exception ex) { Fail("mic", ex); }
        }
    }

    // A failed source is reported, not fatal: the take goes on with whatever else works.
    private void Fail(string source, Exception ex)
    {
        Rpc.Log("error", $"audioCapture.{source}", null, ex);
        _errors.Add(new { source, message = ex.Message });
    }

    public object Start()
    {
        if (State != "idle") throw new RpcException(-32020, $"cannot start audio capture in state {State}");
        T0Ns = WgcCapture.QpcNowNs();
        _sys = StartOrDrop(_sys, "systemAudio");
        _mic = StartOrDrop(_mic, "mic");
        State = "recording";
        return Status();
    }

    private AudioRecorder? StartOrDrop(AudioRecorder? rec, string source)
    {
        if (rec is null) return null;
        try { rec.Start(T0Ns); return rec; }
        catch (Exception ex)
        {
            Fail(source, ex);
            rec.Dispose();
            return null;
        }
    }

    public object Stop()
    {
        if (State != "recording") return Status();
        _stoppedNs = WgcCapture.QpcNowNs();
        _mic?.Stop();
        _sys?.Stop();
        State = "stopped";
        return Status();
    }

    public object Status() => new
    {
        state = State,
        t0Ns = T0Ns,
        durationNs = State == "stopped" ? _stoppedNs - T0Ns : 0,
        system = _sys is null ? null : new { file = "media/system.wav", startNs = _sys.StartNs },
        mic = _mic is null ? null : new { file = "media/mic.wav", startNs = _mic.StartNs },
        errors = _errors,
    };

    public void Dispose()
    {
        if (State == "recording") { try { Stop(); } catch (Exception ex) { Rpc.Log("error", "audioCapture.dispose", null, ex); } }
        _mic?.Dispose();
        _sys?.Dispose();
        _mic = _sys = null;
    }
}
