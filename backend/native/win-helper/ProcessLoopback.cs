using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace WinHelper;

/// <summary>
/// Per-application audio capture (task 1.12, REC-07): WASAPI process loopback via
/// ActivateAudioInterfaceAsync("VAD\Process_Loopback") including the target's process tree.
/// Needs Windows 10 build 20348+ / Windows 11; callers fall back to full-device loopback on failure.
/// Implements NAudio's IWaveIn so AudioRecorder treats it like any other capture source.
/// </summary>
public sealed class ProcessLoopbackCapture : IWaveIn
{
    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { public uint TargetProcessId; public int ProcessLoopbackMode; }
    [StructLayout(LayoutKind.Sequential)]
    private struct AUDIOCLIENT_ACTIVATION_PARAMS { public int ActivationType; public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BLOB { public int cbSize; public IntPtr pBlobData; }
    [StructLayout(LayoutKind.Explicit)]
    private struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public BLOB blob; }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op); }
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation { void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface); }
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    private static extern void ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, [In] ref Guid riid, [In] IntPtr activationParams, [In] IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation op);

    [ComVisible(true)]
    private sealed class Completion : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly TaskCompletionSource<IAudioClient> Tcs = new();
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            op.GetActivateResult(out var hr, out var iface);
            if (hr != 0) Tcs.TrySetException(Marshal.GetExceptionForHR(hr) ?? new Exception($"activation failed 0x{hr:x8}"));
            else Tcs.TrySetResult((IAudioClient)iface);
        }
    }

    private readonly AudioClient _client;
    private readonly EventWaitHandle _event = new(false, EventResetMode.AutoReset);
    private Thread? _thread;
    private volatile bool _running;

    public WaveFormat WaveFormat { get; set; } = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public event EventHandler<StoppedEventArgs>? RecordingStopped;

    private ProcessLoopbackCapture(AudioClient client) { _client = client; }

    public static ProcessLoopbackCapture Create(int pid)
    {
        var p = new AUDIOCLIENT_ACTIVATION_PARAMS
        {
            ActivationType = 1, // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            ProcessLoopbackParams = new AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId = (uint)pid, ProcessLoopbackMode = 0 }, // INCLUDE_TARGET_PROCESS_TREE
        };
        var paramPtr = Marshal.AllocHGlobal(Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>());
        var propPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PROPVARIANT>());
        try
        {
            Marshal.StructureToPtr(p, paramPtr, false);
            Marshal.StructureToPtr(new PROPVARIANT { vt = 65 /* VT_BLOB */, blob = new BLOB { cbSize = Marshal.SizeOf<AUDIOCLIENT_ACTIVATION_PARAMS>(), pBlobData = paramPtr } }, propPtr, false);
            var iid = typeof(IAudioClient).GUID;
            var done = new Completion();
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, propPtr, done, out _);
            if (!done.Tcs.Task.Wait(5000)) throw new TimeoutException("process loopback activation timed out");
            return new ProcessLoopbackCapture(new AudioClient(done.Tcs.Task.Result));
        }
        finally
        {
            Marshal.FreeHGlobal(paramPtr);
            Marshal.FreeHGlobal(propPtr);
        }
    }

    public void StartRecording()
    {
        const AudioClientStreamFlags autoConvert = (AudioClientStreamFlags)0x80000000 | (AudioClientStreamFlags)0x08000000; // AUTOCONVERTPCM | SRC_DEFAULT_QUALITY
        _client.Initialize(AudioClientShareMode.Shared, AudioClientStreamFlags.Loopback | AudioClientStreamFlags.EventCallback | autoConvert, 200_000, 0, WaveFormat, Guid.Empty);
        _client.SetEventHandle(_event.SafeWaitHandle.DangerousGetHandle());
        _client.Start();
        _running = true;
        _thread = new Thread(Loop) { IsBackground = true, Name = "process-loopback", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    private void Loop()
    {
        Exception? error = null;
        try
        {
            var cap = _client.AudioCaptureClient;
            var block = WaveFormat.BlockAlign;
            var buf = new byte[WaveFormat.AverageBytesPerSecond];
            while (_running)
            {
                _event.WaitOne(100);
                int packet;
                while ((packet = cap.GetNextPacketSize()) > 0)
                {
                    var ptr = cap.GetBuffer(out var frames, out var flags);
                    var bytes = frames * block;
                    if (bytes > buf.Length) buf = new byte[bytes];
                    if ((flags & AudioClientBufferFlags.Silent) != 0) Array.Clear(buf, 0, bytes);
                    else Marshal.Copy(ptr, buf, 0, bytes);
                    cap.ReleaseBuffer(frames);
                    DataAvailable?.Invoke(this, new WaveInEventArgs(buf, bytes));
                }
            }
        }
        catch (Exception ex) { error = ex; }
        finally
        {
            try { _client.Stop(); } catch { /* already stopped */ }
            RecordingStopped?.Invoke(this, new StoppedEventArgs(error));
        }
    }

    public void StopRecording()
    {
        _running = false;
        _thread?.Join(1000);
    }

    public void Dispose()
    {
        StopRecording();
        _client.Dispose();
        _event.Dispose();
    }
}
