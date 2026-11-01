using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace WinHelper;

/// <summary>
/// Input telemetry (tasks 1.14, 1.15): low-level mouse/keyboard hooks on a dedicated message-loop thread +
/// 240 Hz GetCursorInfo polling (also works over elevated windows). Writes events/cursor.bin (18-byte records),
/// clicks.jsonl, keys.jsonl, cursors/&lt;id&gt;.png. Flushed every second (append-only, crash-safe).
/// Privacy: printable keys without Ctrl/Alt/Win are stored as {printable:true} with no key code (§5.1).
/// </summary>
public sealed class InputRecorder : IDisposable
{
    // semantic cursor shape ids — mirrored in frontend/shared/src/cursorShapes.ts
    public static readonly (int id, int idc, string name)[] SystemCursors =
    [
        (0, 32512, "arrow"), (1, 32513, "ibeam"), (2, 32649, "pointer"), (3, 32515, "crosshair"),
        (4, 32645, "ns-resize"), (5, 32644, "ew-resize"), (6, 32642, "nwse-resize"), (7, 32643, "nesw-resize"),
        (8, 32646, "move"), (9, 32648, "not-allowed"), (10, 32514, "wait"), (11, 32650, "progress"), (12, 32651, "help"),
        (13, 32516, "up-arrow"),
    ];

    private readonly string _eventsDir;
    private readonly long _t0Ns;
    private readonly Func<(int x, int y)> _origin;
    private readonly ConcurrentQueue<string> _clicks = new();
    private readonly ConcurrentQueue<string> _keys = new();
    private readonly ConcurrentQueue<(long t, float x, float y, ushort shape)> _cursor = new();
    private readonly Dictionary<IntPtr, int> _systemHandles = new();
    private readonly Dictionary<IntPtr, int> _customHandles = new();
    private int _nextCustom = 100;
    private Thread? _hookThread, _pollThread, _flushThread;
    private uint _hookThreadId;
    private volatile bool _running;
    private volatile bool _paused;
    private bool _disposed; // guarded by _flushLock
    private readonly ManualResetEventSlim _stopSignal = new(false);
    private IntPtr _mouseHook, _kbHook;
    private Native.HookProc? _mouseProc, _kbProc; // keep delegates alive
    private FileStream? _cursorFile;
    private StreamWriter? _clickFile, _keyFile;
    public bool Paused { get => _paused; set => _paused = value; }
    private volatile bool _keysPaused;
    /// <summary>Privacy: stop recording keystrokes (e.g. while typing a password); mouse capture continues.</summary>
    public bool KeysPaused { get => _keysPaused; set => _keysPaused = value; }
    public long EventsWritten { get; private set; }

    public InputRecorder(string eventsDir, long t0Ns, Func<(int x, int y)> captureOrigin)
    {
        _eventsDir = eventsDir;
        _t0Ns = t0Ns;
        _origin = captureOrigin;
        Directory.CreateDirectory(Path.Combine(eventsDir, "cursors"));
        foreach (var (id, idc, name) in SystemCursors)
        {
            var h = Native.LoadCursor(IntPtr.Zero, idc);
            if (h != IntPtr.Zero) _systemHandles[h] = id;
            _ = name;
        }
    }

    private long Now() => WgcCapture.QpcNowNs() - _t0Ns;

    public void Start()
    {
        _running = true;
        _cursorFile = new FileStream(Path.Combine(_eventsDir, "cursor.bin"), FileMode.Append, FileAccess.Write, FileShare.Read);
        _clickFile = new StreamWriter(new FileStream(Path.Combine(_eventsDir, "clicks.jsonl"), FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
        _keyFile = new StreamWriter(new FileStream(Path.Combine(_eventsDir, "keys.jsonl"), FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false));
        _hookThread = new Thread(HookLoop) { IsBackground = true, Name = "input-hooks" };
        _hookThread.Start();
        _pollThread = new Thread(PollLoop) { IsBackground = true, Name = "cursor-poll", Priority = ThreadPriority.AboveNormal };
        _pollThread.Start();
        _flushThread = new Thread(FlushLoop) { IsBackground = true, Name = "events-flush" };
        _flushThread.Start();
    }

    private void HookLoop()
    {
        _hookThreadId = Native.GetCurrentThreadId();
        var hmod = Native.GetModuleHandle(null);
        _mouseProc = MouseHook;
        _kbProc = KeyboardHook;
        _mouseHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _mouseProc, hmod, 0);
        _kbHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _kbProc, hmod, 0);
        if (_mouseHook == IntPtr.Zero || _kbHook == IntPtr.Zero)
            Rpc.Log("error", "input.hooks", new { mouse = _mouseHook != IntPtr.Zero, keyboard = _kbHook != IntPtr.Zero, win32 = Marshal.GetLastWin32Error() });
        while (Native.GetMessage(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            Native.TranslateMessage(ref msg);
            Native.DispatchMessage(ref msg);
        }
        if (_mouseHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_mouseHook);
        if (_kbHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_kbHook);
    }

    // Hook procs are reverse-P/Invoke callbacks: an exception escaping them terminates the process, so
    // every callback body is guarded and the event is dropped instead.
    private IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (nCode >= 0 && !_paused)
            {
                var msg = (int)wParam;
                string? button = msg switch { 0x201 or 0x202 => "left", 0x204 or 0x205 => "right", 0x207 or 0x208 => "middle", _ => null };
                if (button is not null)
                {
                    var data = Marshal.PtrToStructure<Native.MSLLHOOKSTRUCT>(lParam);
                    var (ox, oy) = _origin();
                    var phase = msg is 0x201 or 0x204 or 0x207 ? "down" : "up";
                    _clicks.Enqueue($"{{\"t\":{Now()},\"x\":{data.pt.X - ox},\"y\":{data.pt.Y - oy},\"button\":\"{button}\",\"phase\":\"{phase}\"}}");
                }
            }
        }
        catch (Exception ex) { Rpc.Log("warn", "input.mouseHook", null, ex); }
        return Native.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    private IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        try { RecordKey(nCode, wParam, lParam); }
        catch (Exception ex) { Rpc.Log("warn", "input.keyboardHook", null, ex); }
        return Native.CallNextHookEx(_kbHook, nCode, wParam, lParam);
    }

    private void RecordKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && !_paused && !_keysPaused)
        {
            var msg = (int)wParam;
            var down = msg is 0x100 or 0x104;
            var up = msg is 0x101 or 0x105;
            if (down || up)
            {
                var k = Marshal.PtrToStructure<Native.KBDLLHOOKSTRUCT>(lParam);
                var mods = new List<string>(4);
                if (Pressed(0x5B) || Pressed(0x5C)) mods.Add("Meta");
                if (Pressed(0x11)) mods.Add("Ctrl");
                if (Pressed(0x12)) mods.Add("Alt");
                if (Pressed(0x10)) mods.Add("Shift");
                var (code, printable) = VkToCode(k.vkCode);
                var combo = mods.Contains("Ctrl") || mods.Contains("Alt") || mods.Contains("Meta");
                var isTyping = printable && !combo;
                var modsJson = JsonSerializer.Serialize(mods);
                _keys.Enqueue(isTyping
                    ? $"{{\"t\":{Now()},\"mods\":{modsJson},\"phase\":\"{(down ? "down" : "up")}\",\"printable\":true}}"
                    : $"{{\"t\":{Now()},\"code\":\"{code}\",\"mods\":{modsJson},\"phase\":\"{(down ? "down" : "up")}\",\"printable\":false}}");
            }
        }
    }

    private static bool Pressed(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>Virtual-key → KeyboardEvent.code, plus whether it produces a character.</summary>
    public static (string code, bool printable) VkToCode(uint vk) => vk switch
    {
        >= 0x41 and <= 0x5A => ($"Key{(char)vk}", true),
        >= 0x30 and <= 0x39 => ($"Digit{(char)vk}", true),
        >= 0x60 and <= 0x69 => ($"Numpad{vk - 0x60}", true),
        >= 0x70 and <= 0x87 => ($"F{vk - 0x6F}", false),
        0x20 => ("Space", true),
        0x0D => ("Enter", false), 0x1B => ("Escape", false), 0x09 => ("Tab", false), 0x08 => ("Backspace", false),
        0x2E => ("Delete", false), 0x24 => ("Home", false), 0x23 => ("End", false), 0x21 => ("PageUp", false), 0x22 => ("PageDown", false),
        0x25 => ("ArrowLeft", false), 0x26 => ("ArrowUp", false), 0x27 => ("ArrowRight", false), 0x28 => ("ArrowDown", false),
        0x2D => ("Insert", false), 0x2C => ("PrintScreen", false),
        0x10 or 0xA0 => ("ShiftLeft", false), 0xA1 => ("ShiftRight", false),
        0x11 or 0xA2 => ("ControlLeft", false), 0xA3 => ("ControlRight", false),
        0x12 or 0xA4 => ("AltLeft", false), 0xA5 => ("AltRight", false),
        0x5B => ("MetaLeft", false), 0x5C => ("MetaRight", false),
        0xBA => ("Semicolon", true), 0xBB => ("Equal", true), 0xBC => ("Comma", true), 0xBD => ("Minus", true),
        0xBE => ("Period", true), 0xBF => ("Slash", true), 0xC0 => ("Backquote", true), 0xDB => ("BracketLeft", true),
        0xDC => ("Backslash", true), 0xDD => ("BracketRight", true), 0xDE => ("Quote", true),
        0x6A => ("NumpadMultiply", true), 0x6B => ("NumpadAdd", true), 0x6D => ("NumpadSubtract", true), 0x6E => ("NumpadDecimal", true), 0x6F => ("NumpadDivide", true),
        _ => ($"VK{vk}", false),
    };

    private void PollLoop()
    {
        Native.timeBeginPeriod(1);
        try
        {
            const double periodMs = 1000.0 / 240.0;
            var sw = System.Diagnostics.Stopwatch.StartNew();
            var next = 0.0;
            var lastX = int.MinValue; var lastY = int.MinValue; var lastShape = -1;
            while (_running)
            {
                next += periodMs;
                try
                {
                    var info = new Native.CURSORINFO { cbSize = Marshal.SizeOf<Native.CURSORINFO>() };
                    if (!_paused && Native.GetCursorInfo(ref info))
                    {
                        var shape = (info.flags & Native.CURSOR_SHOWING) != 0 ? ShapeId(info.hCursor) : 65535;
                        var (ox, oy) = _origin();
                        var x = info.ptScreenPos.X - ox; var y = info.ptScreenPos.Y - oy;
                        if (x != lastX || y != lastY || shape != lastShape)
                        {
                            _cursor.Enqueue((Now(), x, y, (ushort)shape));
                            lastX = x; lastY = y; lastShape = shape;
                        }
                    }
                }
                catch (Exception ex) { Rpc.Log("warn", "input.poll", null, ex); }
                var wait = next - sw.Elapsed.TotalMilliseconds;
                if (wait > 1.5) Thread.Sleep((int)(wait - 0.5));
                else if (wait < -50) next = sw.Elapsed.TotalMilliseconds; // fell behind (sleep/wake) → resync
            }
        }
        finally { Native.timeEndPeriod(1); }
    }

    private int ShapeId(IntPtr h)
    {
        if (_systemHandles.TryGetValue(h, out var id)) return id;
        if (_customHandles.TryGetValue(h, out id)) return id;
        id = _nextCustom++;
        _customHandles[h] = id;
        try { SaveCursorBitmap(h, id); } catch (Exception ex) { Rpc.Log("warn", "input.cursorBitmap", new { id }, ex); }
        return id;
    }

    /// <summary>Unknown app cursor → PNG + hotspot JSON (handles monochrome AND/XOR cursors via DrawIcon).</summary>
    private void SaveCursorBitmap(IntPtr h, int id)
    {
        var copy = Native.CopyIcon(h);
        if (copy == IntPtr.Zero) return;
        try
        {
            if (!Native.GetIconInfo(copy, out var ii)) return;
            try
            {
                using var icon = Icon.FromHandle(copy);
                using var bmp = new Bitmap(64, 64, PixelFormat.Format32bppArgb);
                using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); g.DrawIcon(icon, 0, 0); }
                bmp.Save(Path.Combine(_eventsDir, "cursors", $"{id}.png"), ImageFormat.Png);
                File.WriteAllText(Path.Combine(_eventsDir, "cursors", $"{id}.json"), $"{{\"hotspot\":[{ii.xHotspot},{ii.yHotspot}],\"semantic\":\"custom\",\"size\":64}}");
            }
            finally
            {
                if (ii.hbmColor != IntPtr.Zero) Native.DeleteObject(ii.hbmColor);
                if (ii.hbmMask != IntPtr.Zero) Native.DeleteObject(ii.hbmMask);
            }
        }
        finally { Native.DestroyIcon(copy); }
    }

    // Woken by Stop() instead of sleeping a full second, so it can be joined before the files are closed.
    // (Previously it could wake after Dispose and flush a closed FileStream → unhandled exception → helper crash on stop.)
    private void FlushLoop()
    {
        while (!_stopSignal.Wait(1000)) Flush();
    }

    private readonly object _flushLock = new();
    private void Flush()
    {
        lock (_flushLock)
        {
            if (_disposed || _cursorFile is null || _clickFile is null || _keyFile is null) return;
            try
            {
                Span<byte> rec = stackalloc byte[18];
                while (_cursor.TryDequeue(out var c))
                {
                    BitConverter.TryWriteBytes(rec[..8], c.t);
                    BitConverter.TryWriteBytes(rec.Slice(8, 4), c.x);
                    BitConverter.TryWriteBytes(rec.Slice(12, 4), c.y);
                    BitConverter.TryWriteBytes(rec.Slice(16, 2), c.shape);
                    _cursorFile.Write(rec);
                    EventsWritten++;
                }
                while (_clicks.TryDequeue(out var l)) { _clickFile.WriteLine(l); EventsWritten++; }
                while (_keys.TryDequeue(out var l)) { _keyFile.WriteLine(l); EventsWritten++; }
                _cursorFile.Flush(true);
                _clickFile.Flush();
                _keyFile.Flush();
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                Rpc.Log("error", "input.flush", null, ex); // disk full / file gone: keep the session alive
            }
        }
    }

    public void Stop()
    {
        if (!_running) return;
        _running = false;
        _stopSignal.Set();
        if (_hookThreadId != 0) Native.PostThreadMessage(_hookThreadId, Native.WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        _pollThread?.Join(1000);
        _hookThread?.Join(1000);
        _flushThread?.Join(2000);
        Flush();
    }

    public void Dispose()
    {
        Stop();
        lock (_flushLock)
        {
            if (_disposed) return;
            _disposed = true;
            _cursorFile?.Dispose();
            _clickFile?.Dispose();
            _keyFile?.Dispose();
        }
        // _stopSignal is intentionally not disposed: a flush thread that outlived its join may still Wait() on it.
    }
}
