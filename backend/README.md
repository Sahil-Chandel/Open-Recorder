# Native capture helpers

The desktop app (`frontend/desktop`) records through a small native helper per OS. Each helper is a separate
process that talks JSON-RPC over stdio, so a crash in capture code never takes the editor down.

| Folder | OS | What it does |
|---|---|---|
| `native/win-helper` | Windows 10 2004+ | C# / .NET 8. Windows.Graphics.Capture (cursor-free), hardware H.264 via ffmpeg (NVENC / AMF / QSV / Media Foundation, x264 fallback), WASAPI mic + system / per-app audio, low-level mouse + keyboard hooks, cursor shapes, crash-safe segments |
| `native/mac-helper` | macOS 13+ | Swift. ScreenCaptureKit capture + audio, AVFoundation camera / mic, CGEventTap input |

Both are built and bundled by `frontend/desktop/scripts/prepare-bin.mjs` (see the root README).

```powershell
# Windows, for development (the app finds bin/Release automatically)
cd backend/native/win-helper
dotnet build -c Release
```

```bash
# macOS
swift build -c release --package-path backend/native/mac-helper
```
