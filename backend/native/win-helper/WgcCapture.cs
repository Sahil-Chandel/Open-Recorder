using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace WinHelper;

[ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
internal interface IGraphicsCaptureItemInterop
{
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
}

[ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
internal interface IDirect3DDxgiInterfaceAccess
{
    IntPtr GetInterface([In] ref Guid iid);
}

/// <summary>
/// Windows.Graphics.Capture source (task 1.10): cursor-free (IsCursorCaptureEnabled=false), borderless where
/// allowed, cross-adapter safe (works on hybrid Intel+NVIDIA laptops where DXGI duplication fails).
/// Frames arrive only on change; the encoder thread samples the latest frame at a constant rate (CFR).
/// Area capture = GPU sub-region copy before CPU readback.
/// </summary>
public sealed class WgcCapture : IDisposable
{
    private static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _ctx;
    private readonly IDirect3DDevice _winrtDevice;
    private readonly GraphicsCaptureItem _item;
    private Direct3D11CaptureFramePool _pool;
    private readonly GraphicsCaptureSession _session;
    private ID3D11Texture2D? _staging;
    private readonly object _frameLock = new();
    /// <summary>Serialises GPU work in OnFrame against device disposal (FrameArrived fires on a pool thread).</summary>
    private readonly object _gpuLock = new();
    private byte[] _latest;
    private long _latestNs = -1;
    private Windows.Graphics.SizeInt32 _poolSize;
    private readonly (int x, int y, int w, int h) _region;
    private bool _disposed;

    public int Width => _region.w;
    public int Height => _region.h;
    public long FramesArrived { get; private set; }

    /// <param name="region">sub-rect inside the item (item-relative px); full item when null</param>
    private WgcCapture(GraphicsCaptureItem item, (int x, int y, int w, int h)? region)
    {
        _item = item;
        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport,
            [FeatureLevel.Level_11_1, FeatureLevel.Level_11_0], out var device).CheckError();
        _device = device!;
        _ctx = _device.ImmediateContext;
        using (var dxgi = _device.QueryInterface<IDXGIDevice>())
        {
            Marshal.ThrowExceptionForHR(Native.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var inspectable));
            _winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
            Marshal.Release(inspectable);
        }
        var size = item.Size;
        var r = region ?? (0, 0, size.Width, size.Height);
        // H.264 needs even dimensions
        _region = (Math.Max(0, r.x), Math.Max(0, r.y), Math.Max(2, r.w & ~1), Math.Max(2, r.h & ~1));
        _latest = new byte[_region.w * _region.h * 4];
        _poolSize = size;
        _pool = Direct3D11CaptureFramePool.CreateFreeThreaded(_winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
        _pool.FrameArrived += OnFrame;
        _session = _pool.CreateCaptureSession(item);
        _session.IsCursorCaptureEnabled = false;
        // yellow capture border can only be disabled on Windows 11 / Server 2022+ (build 20348)
        if (Windows.Foundation.Metadata.ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "IsBorderRequired"))
        {
            try { _session.IsBorderRequired = false; } catch (Exception ex) { Rpc.Log("warn", "wgc.border", null, ex); }
        }
    }

    public static bool IsSupported() => GraphicsCaptureSession.IsSupported();

    public static WgcCapture ForMonitor(IntPtr hmon, (int x, int y, int w, int h)? region = null)
    {
        var factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        var interop = factory.AsInterface<IGraphicsCaptureItemInterop>();
        var iid = GraphicsCaptureItemIid;
        var ptr = interop.CreateForMonitor(hmon, ref iid);
        var item = GraphicsCaptureItem.FromAbi(ptr);
        Marshal.Release(ptr);
        return new WgcCapture(item, region);
    }

    public static WgcCapture ForWindow(IntPtr hwnd)
    {
        var factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");
        var interop = factory.AsInterface<IGraphicsCaptureItemInterop>();
        var iid = GraphicsCaptureItemIid;
        var ptr = interop.CreateForWindow(hwnd, ref iid);
        var item = GraphicsCaptureItem.FromAbi(ptr);
        Marshal.Release(ptr);
        return new WgcCapture(item, null);
    }

    public void Start() => _session.StartCapture();

    private void OnFrame(Direct3D11CaptureFramePool sender, object args)
    {
        try
        {
            lock (_gpuLock) CopyFrame(sender);
        }
        catch (Exception ex) { Rpc.Log("error", "wgc.frame", null, ex); }
    }

    private void CopyFrame(Direct3D11CaptureFramePool sender)
    {
        if (_disposed) return;
        using var frame = sender.TryGetNextFrame();
        if (frame is null) return;
        var cs = frame.ContentSize;
        if (cs.Width != _poolSize.Width || cs.Height != _poolSize.Height)
        {
            // window resized: recreate the pool; output size stays fixed (cropped / black-padded)
            _poolSize = cs;
            sender.Recreate(_winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, cs);
        }
        var access = frame.Surface.As<IDirect3DDxgiInterfaceAccess>();
        var texIid = typeof(ID3D11Texture2D).GUID;
        var texPtr = access.GetInterface(ref texIid);
        using var tex = new ID3D11Texture2D(texPtr);
        var desc = tex.Description;
        var w = Math.Min(_region.w, (int)desc.Width - _region.x);
        var h = Math.Min(_region.h, (int)desc.Height - _region.y);
        if (w <= 0 || h <= 0) return;
        _staging ??= _device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)_region.w, Height = (uint)_region.h, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Staging, CPUAccessFlags = CpuAccessFlags.Read, BindFlags = BindFlags.None,
        });
        var box = new Vortice.Mathematics.Box(_region.x, _region.y, 0, _region.x + w, _region.y + h, 1);
        _ctx.CopySubresourceRegion(_staging, 0, 0, 0, 0, tex, 0, box);
        var map = _ctx.Map(_staging, 0, MapMode.Read);
        try
        {
            lock (_frameLock)
            {
                var rowBytes = _region.w * 4;
                if (w < _region.w || h < _region.h) Array.Clear(_latest);
                unsafe
                {
                    fixed (byte* dst = _latest)
                    {
                        var src = (byte*)map.DataPointer;
                        for (var y = 0; y < h; y++)
                            Buffer.MemoryCopy(src + y * map.RowPitch, dst + y * rowBytes, rowBytes, w * 4);
                    }
                }
                _latestNs = frame.SystemRelativeTime.Ticks * 100;
                FramesArrived++;
            }
        }
        finally { _ctx.Unmap(_staging, 0); }
    }

    /// <summary>Copy the most recent frame into dst. Returns false until the first frame arrived.</summary>
    public bool CopyLatest(byte[] dst)
    {
        lock (_frameLock)
        {
            if (_latestNs < 0) return false;
            Buffer.BlockCopy(_latest, 0, dst, 0, _latest.Length);
            return true;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        // Close the session/pool outside _gpuLock: Close() may wait for an in-flight FrameArrived handler,
        // which itself needs _gpuLock. The handler re-checks _disposed under the lock before touching the device.
        try { _session.Dispose(); } catch { /* already closed */ }
        try { _pool.Dispose(); } catch { /* already closed */ }
        lock (_gpuLock)
        {
            _staging?.Dispose();
            _ctx.Dispose();
            _device.Dispose();
        }
    }

    public static long QpcNowNs() => (long)(Stopwatch.GetTimestamp() * (1e9 / Stopwatch.Frequency));
}
