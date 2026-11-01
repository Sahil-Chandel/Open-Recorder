using System.Collections.Specialized;
using System.Runtime.InteropServices;

namespace WinHelper;

/// <summary>Clean desktop (task 2.8) and clipboard file copy (task 4.5).</summary>
public static class Shell
{
    private static IntPtr DesktopListView()
    {
        // Icons live in SysListView32 under SHELLDLL_DefView, parented by Progman or a WorkerW.
        var progman = Native.FindWindow("Progman", null);
        var defView = Native.FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero)
        {
            var worker = IntPtr.Zero;
            while ((worker = Native.FindWindowEx(IntPtr.Zero, worker, "WorkerW", null)) != IntPtr.Zero)
            {
                defView = Native.FindWindowEx(worker, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (defView != IntPtr.Zero) break;
            }
        }
        return defView == IntPtr.Zero ? IntPtr.Zero : Native.FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
    }

    public record DesktopState(bool IconsVisible, bool TaskbarAutoHide);

    public static DesktopState GetDesktopState()
    {
        var lv = DesktopListView();
        var abd = new Native.APPBARDATA { cbSize = Marshal.SizeOf<Native.APPBARDATA>() };
        var state = (long)Native.SHAppBarMessage(Native.ABM_GETSTATE, ref abd);
        return new DesktopState(lv != IntPtr.Zero && Native.IsWindowVisible(lv), (state & Native.ABS_AUTOHIDE) != 0);
    }

    /// <summary>Apply icons/taskbar visibility. Returns the previous state so main can persist + restore after crashes.</summary>
    public static DesktopState SetDesktop(bool? iconsVisible, bool? taskbarAutoHide)
    {
        var prev = GetDesktopState();
        if (iconsVisible is not null)
        {
            var lv = DesktopListView();
            if (lv != IntPtr.Zero) Native.ShowWindow(lv, iconsVisible.Value ? 5 : 0);
        }
        if (taskbarAutoHide is not null)
        {
            var abd = new Native.APPBARDATA
            {
                cbSize = Marshal.SizeOf<Native.APPBARDATA>(),
                hWnd = Native.FindWindow("Shell_TrayWnd", null),
                lParam = new IntPtr(taskbarAutoHide.Value ? Native.ABS_AUTOHIDE : 0),
            };
            Native.SHAppBarMessage(Native.ABM_SETSTATE, ref abd);
        }
        return prev;
    }

    /// <summary>CF_HDROP file copy so the exported video can be pasted into chat apps / Explorer.</summary>
    public static void CopyFileToClipboard(string path)
    {
        if (!File.Exists(path)) throw new RpcException(-32602, "file not found");
        Exception? error = null;
        var t = new Thread(() =>
        {
            try
            {
                var files = new StringCollection { Path.GetFullPath(path) };
                System.Windows.Forms.Clipboard.SetFileDropList(files);
            }
            catch (Exception ex) { error = ex; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join(5000);
        if (error is not null) throw error;
    }
}
