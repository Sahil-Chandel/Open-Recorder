using System.Text.Json;
using System.Text.Json.Nodes;
using NAudio.CoreAudioApi;
using WinHelper;

const string Version = "0.2.0";
var jsonOpts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
RecordingSession? session = null;
LevelMonitor? levels = null;
AudioOnlySession? audioCapture = null; // device (Android) takes: PC mic + system audio only
var sessionLock = new object();

// Last-chance diagnostics: a crash on a background thread used to surface only as exit code 0xE0434352.
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    try { Rpc.Log("fatal", "helper.unhandled", new { terminating = e.IsTerminating, detail = e.ExceptionObject.ToString() }, e.ExceptionObject as Exception); }
    catch { /* stderr gone */ }
};
TaskScheduler.UnobservedTaskException += (_, e) => { Rpc.Log("error", "helper.unobservedTask", null, e.Exception); e.SetObserved(); };

if (args.Length > 1 && args[0] == "--selftest-input")
{
    // Regression check for the stop-time crash: start/stop/dispose the input recorder, then stay alive long
    // enough for any straggling background thread to fire. No screen or audio is captured.
    var rec = new InputRecorder(args[1], WgcCapture.QpcNowNs(), () => (0, 0));
    rec.Start();
    Thread.Sleep(1500);
    rec.Stop();
    rec.Dispose();
    Thread.Sleep(2500);
    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, events = rec.EventsWritten }, jsonOpts));
    return 0;
}

if (args.Length > 0 && args[0] == "--selftest")
{
    // capture-test (task 1.20, reduced): record N seconds of the primary display, report frame stats.
    var dir = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "recorder-selftest");
    var secs = args.Length > 2 ? int.Parse(args[2]) : 3;
    var disp = Enumeration.ListDisplays().First(d => d.Primary);
    var cfg = new RecordingConfig(dir, "display", disp.Id, null, null, 30, "medium", "auto",
        new SystemAudioCfg(true, null, null), new MicCfg(false, null), true, []);
    using var s = new RecordingSession(cfg);
    s.Start();
    Thread.Sleep(secs * 1000);
    var result = s.Stop();
    Console.WriteLine(JsonSerializer.Serialize(new { ok = true, wgc = WgcCapture.IsSupported(), dropped = s.DroppedFrames, result }, jsonOpts));
    return 0;
}

T Parse<T>(JsonNode? p) => (p ?? throw new RpcException(-32602, "params required")).Deserialize<T>(jsonOpts) ?? throw new RpcException(-32602, "invalid params");
string Str(JsonNode? p, string key) => p?[key]?.GetValue<string>() ?? throw new RpcException(-32602, $"{key} required");

async Task<object?> Dispatch(string method, JsonNode? p)
{
    await Task.Yield();
    switch (method)
    {
        case "ping": return new { pong = true, t = WgcCapture.QpcNowNs() };
        case "version": return new { version = Version, platform = "win32", wgc = WgcCapture.IsSupported(), encoder = FfmpegEncoder.ProbeEncoder("auto") };
        case "listDisplays": return Enumeration.ListDisplays();
        case "listWindows":
            var ex = p?["excludePids"]?.AsArray().Select(n => n!.GetValue<int>()).ToArray() ?? [];
            return Enumeration.ListWindows(ex);
        case "windowThumbnail": return new { png = Enumeration.WindowThumbnail(new IntPtr(long.Parse(Str(p, "id")))) };
        case "listAudioInputs": return Enumeration.ListAudio(DataFlow.Capture);
        case "listAudioOutputs": return Enumeration.ListAudio(DataFlow.Render);
        case "listAudioApps": return Enumeration.ListAudioApps();
        case "startLevels":
            lock (sessionLock) { levels?.Dispose(); levels = new LevelMonitor(p?["micId"]?.GetValue<string>(), p?["outputId"]?.GetValue<string>()); }
            return new { ok = true };
        case "stopLevels":
            lock (sessionLock) { levels?.Dispose(); levels = null; }
            return new { ok = true };
        case "startRecording":
        {
            var cfg = Parse<RecordingConfig>(p);
            lock (sessionLock)
            {
                if (session is { State: "recording" or "paused" }) throw new RpcException(-32020, "already recording");
                levels?.Dispose(); levels = null; // the session emits its own levels
                session?.Dispose();
                session = new RecordingSession(cfg);
            }
            session.Start();
            Rpc.Log("info", "session.start", new { cfg.Mode, cfg.Fps });
            return session.Status();
        }
        case "pause": lock (sessionLock) { (session ?? throw new RpcException(-32020, "not recording")).Pause(); return session.Status(); }
        case "resume": lock (sessionLock) { (session ?? throw new RpcException(-32020, "not recording")).Resume(); return session.Status(); }
        case "stop":
            lock (sessionLock)
            {
                var s = session ?? throw new RpcException(-32020, "not recording");
                var r = s.Stop();
                s.Dispose();
                session = null;
                Rpc.Log("info", "session.stop", new { dropped = s.DroppedFrames });
                return r;
            }
        case "setKeysPaused":
            lock (sessionLock) { session?.SetKeysPaused(p?["paused"]?.GetValue<bool>() ?? false); }
            return new { ok = true };
        case "setMicMuted":
            lock (sessionLock) { session?.SetMicMuted(p?["muted"]?.GetValue<bool>() ?? false); }
            return new { ok = true };
        case "startAudioCapture":
        {
            var cfg = Parse<AudioCaptureConfig>(p);
            lock (sessionLock)
            {
                if (audioCapture is { State: "recording" }) throw new RpcException(-32020, "audio capture already running");
                audioCapture?.Dispose();
                audioCapture = new AudioOnlySession(cfg);
                var r = audioCapture.Start();
                Rpc.Log("info", "audioCapture.start", new { system = cfg.SystemAudio?.Enabled ?? false, mic = cfg.Mic?.Enabled ?? false });
                return r;
            }
        }
        case "stopAudioCapture":
            lock (sessionLock)
            {
                var a = audioCapture ?? throw new RpcException(-32020, "audio capture not running");
                var r = a.Stop();
                a.Dispose();
                audioCapture = null;
                Rpc.Log("info", "audioCapture.stop");
                return r;
            }
        case "status": return session?.Status() ?? new { state = "idle", segment = -1, elapsedNs = 0, droppedFrames = 0, bytesWritten = 0 };
        case "setDesktopClean":
            return Shell.SetDesktop(p?["iconsVisible"]?.GetValue<bool?>(), p?["taskbarAutoHide"]?.GetValue<bool?>());
        case "getDesktopState": return Shell.GetDesktopState();
        case "copyFileToClipboard": Shell.CopyFileToClipboard(Str(p, "path")); return new { ok = true };
        default: throw new RpcException(-32601, $"method not found: {method}");
    }
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
Rpc.Log("info", "helper.start", new { version = Version, pid = Environment.ProcessId });
try { await Rpc.Serve(Dispatch, cts.Token); }
catch (OperationCanceledException) { /* shutdown */ }
finally
{
    lock (sessionLock) { session?.Dispose(); levels?.Dispose(); audioCapture?.Dispose(); }
    Rpc.Log("info", "helper.exit");
}
return 0;
