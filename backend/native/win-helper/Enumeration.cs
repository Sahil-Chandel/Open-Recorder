using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using NAudio.CoreAudioApi;

namespace WinHelper;

public record DisplayInfo(string Id, string Name, int X, int Y, int Width, int Height, double ScaleFactor, bool Primary, int Index);
public record WindowInfo(string Id, string Title, string App, int Pid, int X, int Y, int Width, int Height);
public record AudioDeviceInfo(string Id, string Name, bool IsDefault);
public record AudioAppInfo(int Pid, string Name);

/// <summary>Device / window enumeration (tasks 1.1, 1.9). Coordinates are physical pixels (PerMonitorV2).</summary>
public static class Enumeration
{
    public static List<DisplayInfo> ListDisplays()
    {
        var list = new List<(IntPtr h, Native.MONITORINFOEX info)>();
        Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr h, IntPtr _, ref Native.RECT _, IntPtr _) =>
        {
            var mi = new Native.MONITORINFOEX { cbSize = System.Runtime.InteropServices.Marshal.SizeOf<Native.MONITORINFOEX>() };
            if (Native.GetMonitorInfo(h, ref mi)) list.Add((h, mi));
            return true;
        }, IntPtr.Zero);
        return list.Select((m, i) =>
        {
            Native.GetDpiForMonitor(m.h, 0, out var dpi, out _);
            var r = m.info.rcMonitor;
            return new DisplayInfo(m.h.ToInt64().ToString(), m.info.szDevice.TrimStart('\\', '.'), r.Left, r.Top, r.Width, r.Height,
                dpi > 0 ? dpi / 96.0 : 1.0, (m.info.dwFlags & 1) != 0, i);
        }).ToList();
    }

    public static List<WindowInfo> ListWindows(IReadOnlyCollection<int> excludePids)
    {
        var result = new List<WindowInfo>();
        var self = Environment.ProcessId;
        Native.EnumWindows((hwnd, _) =>
        {
            if (!Native.IsWindowVisible(hwnd) || Native.IsIconic(hwnd)) return true;
            if (Native.GetWindow(hwnd, Native.GW_OWNER) != IntPtr.Zero) return true;
            var ex = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE);
            if ((ex & Native.WS_EX_TOOLWINDOW) != 0 || (ex & Native.WS_EX_NOACTIVATE) != 0) return true;
            if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            var len = Native.GetWindowTextLength(hwnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == self || excludePids.Contains((int)pid)) return true;
            var rect = WindowBounds(hwnd);
            if (rect.Width < 50 || rect.Height < 50) return true;
            string app;
            try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "unknown"; }
            result.Add(new WindowInfo(hwnd.ToInt64().ToString(), sb.ToString(), app, (int)pid, rect.Left, rect.Top, rect.Width, rect.Height));
            return true;
        }, IntPtr.Zero);
        return result;
    }

    /// <summary>Visible frame bounds (excludes the invisible resize border on Windows 10+).</summary>
    public static Native.RECT WindowBounds(IntPtr hwnd)
    {
        if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_EXTENDED_FRAME_BOUNDS, out Native.RECT r, System.Runtime.InteropServices.Marshal.SizeOf<Native.RECT>()) == 0) return r;
        Native.GetWindowRect(hwnd, out r);
        return r;
    }

    /// <summary>PNG thumbnail (base64) via PrintWindow(PW_RENDERFULLCONTENT). Bounded to maxW for IPC size.</summary>
    public static string? WindowThumbnail(IntPtr hwnd, int maxW = 320)
    {
        var r = WindowBounds(hwnd);
        if (r.Width <= 0 || r.Height <= 0) return null;
        using var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            var hdc = g.GetHdc();
            try { Native.PrintWindow(hwnd, hdc, 2); } finally { g.ReleaseHdc(hdc); }
        }
        var scale = Math.Min(1.0, (double)maxW / r.Width);
        using var thumb = new Bitmap(bmp, new Size(Math.Max(1, (int)(r.Width * scale)), Math.Max(1, (int)(r.Height * scale))));
        using var ms = new MemoryStream();
        thumb.Save(ms, ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
    }

    public static List<AudioDeviceInfo> ListAudio(DataFlow flow)
    {
        using var en = new MMDeviceEnumerator();
        string? def = null;
        try { def = en.GetDefaultAudioEndpoint(flow, Role.Console).ID; } catch { /* no default device */ }
        return en.EnumerateAudioEndPoints(flow, DeviceState.Active).Select(d => new AudioDeviceInfo(d.ID, d.FriendlyName, d.ID == def)).ToList();
    }

    /// <summary>Processes with an active audio session on the default render device (REC-07 picker).</summary>
    public static List<AudioAppInfo> ListAudioApps()
    {
        var apps = new Dictionary<int, string>();
        using var en = new MMDeviceEnumerator();
        foreach (var dev in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            var sessions = dev.AudioSessionManager.Sessions;
            for (var i = 0; i < sessions.Count; i++)
            {
                var pid = (int)sessions[i].GetProcessID;
                if (pid == 0 || apps.ContainsKey(pid)) continue;
                try { apps[pid] = Process.GetProcessById(pid).ProcessName; } catch { /* exited */ }
            }
        }
        return apps.Select(kv => new AudioAppInfo(kv.Key, kv.Value)).OrderBy(a => a.Name).ToList();
    }
}
