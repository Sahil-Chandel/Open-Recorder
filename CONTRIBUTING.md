# Contributing to Open-Recorder

Thanks for taking the time to contribute! Bug reports, feature ideas, documentation fixes and pull requests are
all welcome.

## Reporting bugs

1. Search the [existing issues](https://github.com/Sahil-Chandel/Open-Recorder/issues) first.
2. Open a new issue with:
   - what you did, what you expected and what happened instead;
   - your OS version, GPU and the Open-Recorder version (**Settings → About**);
   - the log file: **Settings → About → Report a problem → Show log file**
     (`%APPDATA%\Open-Recorder\logs\main.log` on Windows, `~/Library/Logs/Open-Recorder/main.log` on macOS).

Please report security vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## Suggesting features

Open an issue describing the problem you want to solve and how you imagine it working. Mock-ups or short screen
recordings are very welcome.

## Development setup

Requirements: Node.js 24, FFmpeg on your `PATH`, the .NET 8 SDK (Windows) or the Xcode command-line tools (macOS).

```bash
git clone https://github.com/Sahil-Chandel/Open-Recorder.git
cd Open-Recorder

# Windows: build the capture helper (repeat after changing backend/native/win-helper)
dotnet build -c Release backend/native/win-helper
# macOS: swift build -c release --package-path backend/native/mac-helper

cd frontend
npm ci
npm run dev:desktop
```

On Windows, `scripts/update-local.ps1` rebuilds both the helper and the desktop app in one go.

| Folder | What lives there |
|---|---|
| `frontend/shared` | Pure TypeScript engine (schema, time model, zoom, cursor, captions, Smart Cut). Keep it free of Electron and DOM APIs. |
| `frontend/desktop` | Electron app — `src/main` (main process), `src/preload`, `src/renderer` (React UI, compositor, export). |
| `frontend/web` | Project website and in-browser recorders. |
| `backend/native` | Native capture helpers (C# for Windows, Swift for macOS). See [backend/README.md](backend/README.md). |

## Before opening a pull request

- Run the checks from `frontend/`:
  ```bash
  npm run typecheck
  npm test
  ```
- Add or update tests for behaviour you change — the engine in `frontend/shared` is expected to stay fully
  unit-tested.
- Follow the existing style: Prettier settings are in `frontend/.prettierrc` (single quotes, 110 columns).
- Keep pull requests focused, describe what changed and how you tested it, and include a screenshot or short clip
  for UI changes.

### Testing without your camera or microphone

The desktop app has a headless smoke mode that keeps its windows hidden and never opens the microphone or camera:

```powershell
$env:RECORDER_DATA_DIR = "$PWD\.dev-data"         # app data stays in this folder
$env:RECORDER_SMOKE    = "$PWD\.dev-data\smoke"   # screenshots + smoke.json are written here
$env:RECORDER_SMOKE_FIXTURE = '1'                 # optional: create a sample project
$env:RECORDER_SMOKE_EXPORT  = '1'                 # optional: also export it to MP4 and GIF
cd frontend/desktop
npx electron-vite build
npx electron .
```

### Troubleshooting

- **Electron starts as plain Node.js** (for example `app` is undefined): some tools set `ELECTRON_RUN_AS_NODE=1`.
  Clear it before launching (`Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell, `unset ELECTRON_RUN_AS_NODE`
  in bash).
- **"win-helper binary not found"**: build the capture helper with `dotnet build -c Release backend/native/win-helper`.

## License

By contributing, you agree that your contributions are licensed under the
[GNU General Public License v3.0](LICENSE), the same license as the project.
