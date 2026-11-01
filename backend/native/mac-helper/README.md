# mac-helper (Swift, ScreenCaptureKit)

Same JSON-RPC 2.0 over stdio protocol as `../win-helper` (methods: ping, version, listDisplays, listWindows,
listAudioInputs, listAudioOutputs, listAudioApps, startRecording, pause, resume, stop, status, setMicMuted,
startLevels, stopLevels, setDesktopClean, copyFileToClipboard).

* Screen / window / area via `SCStream` with `showsCursor = false`, own app always excluded from the filter
  (control bar, countdown and teleprompter never appear), Finder desktop icons + Dock excluded on request.
* H.264 via `AVAssetWriter` (VideoToolbox hardware) with `movieFragmentInterval = 2 s` (crash-safe).
* System audio from SCK (`capturesAudio`, `excludesCurrentProcessAudio`); per-app audio = 2nd audio-only stream
  filtered to the chosen app. Mic via `AVCaptureSession` into its own WAV. One host clock for everything.
* Input: listen-only `CGEventTap` + 120 Hz `NSEvent.mouseLocation` polling; cursor shapes from
  `NSCursor.currentSystem` (hashed PNG + hotspot). Needs Accessibility / Input Monitoring.
* iPhone/iPad (task 11.4): `kCMIOHardwarePropertyAllowScreenCaptureDevices` enables USB iOS devices as
  muxed `AVCaptureDevice`s (`listIosDevices`, `startRecording { mode: "ios", deviceId }`).

**Status:** written on a Windows dev box — not compiled or tested yet. Build and test on macOS 13+.