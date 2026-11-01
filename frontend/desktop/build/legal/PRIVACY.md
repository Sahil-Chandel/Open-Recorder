# Privacy

Open-Recorder is free, open-source software that runs entirely on your computer.

* **No account, no servers.** There is no sign-in and nothing is uploaded. Recordings, projects and exports
  stay in the folders you choose (by default `Videos/Open-Recorder`).
* **Keystrokes.** Typed characters are never stored. Only shortcut combinations and non-printing keys (Enter,
  Esc, arrows…) are kept, for the keyboard overlay; plain typing is stored as "a key was pressed" for typing
  detection. You can pause keystroke capture during a recording (Alt+Shift+K, or the keyboard button).
* **Downloads on first use.** Some optional features download free models once, over HTTPS, and verify their
  SHA-256 checksum: the Whisper speech model and engine for captions, the MediaPipe model for background
  removal, and Android platform-tools for phone recording. Only the file is requested — no recording data is sent.
* **Logs.** The app keeps a local log file for troubleshooting (Settings → About → Show log file). It contains
  no screen content and no typed text, and it is never sent anywhere unless you attach it to an issue yourself.
