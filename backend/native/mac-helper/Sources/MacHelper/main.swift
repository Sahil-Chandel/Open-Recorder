// macOS capture helper — JSON-RPC 2.0 over stdio (one JSON object per line). See README.md.
import AppKit
import AVFoundation
import CoreMediaIO
import Foundation
import ScreenCaptureKit

// MARK: - RPC plumbing

let outLock = NSLock()
func send(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    outLock.lock(); FileHandle.standardOutput.write(line.data(using: .utf8)!); outLock.unlock()
}
func notify(_ method: String, _ params: [String: Any]) { send(["jsonrpc": "2.0", "method": method, "params": params]) }
func log(_ level: String, _ op: String, _ ctx: [String: Any] = [:]) {
    let rec: [String: Any] = ["timestamp": ISO8601DateFormatter().string(from: Date()), "level": level, "operation": op, "module": "mac-helper", "context": ctx]
    if let d = try? JSONSerialization.data(withJSONObject: rec) { FileHandle.standardError.write(d + "\n".data(using: .utf8)!) }
}
struct RpcError: Error { let code: Int; let message: String }

/// Host-clock nanoseconds (mach_absolute_time based) — every track and event shares this clock (§4.4).
func hostNowNs() -> Int64 { Int64(CMClockGetTime(CMClockGetHostTimeClock()).seconds * 1e9) }

// MARK: - Enumeration

func shareable() async throws -> SCShareableContent {
    try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
}

func listDisplays() async throws -> [[String: Any]] {
    let content = try await shareable()
    return content.displays.enumerated().map { i, d in
        let scale = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) == d.displayID }?.backingScaleFactor ?? 2
        return ["id": String(d.displayID), "name": "Display \(i + 1)", "x": d.frame.origin.x * scale, "y": d.frame.origin.y * scale,
                "width": Double(d.width) * scale, "height": Double(d.height) * scale, "scaleFactor": scale, "primary": CGDisplayIsMain(d.displayID) != 0, "index": i]
    }
}

func listWindows(exclude: Set<Int32>) async throws -> [[String: Any]] {
    let me = ProcessInfo.processInfo.processIdentifier
    return try await shareable().windows.filter { w in
        guard let app = w.owningApplication, w.isOnScreen, w.frame.width > 50, w.frame.height > 50, (w.title ?? "").isEmpty == false else { return false }
        return app.processID != me && !exclude.contains(app.processID) && w.windowLayer == 0
    }.map { w in
        ["id": String(w.windowID), "title": w.title ?? "", "app": w.owningApplication?.applicationName ?? "", "pid": w.owningApplication?.processID ?? 0,
         "x": w.frame.origin.x, "y": w.frame.origin.y, "width": w.frame.width, "height": w.frame.height]
    }
}

func listAudioInputs() -> [[String: Any]] {
    let def = AVCaptureDevice.default(for: .audio)?.uniqueID
    return AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices.map {
        ["id": $0.uniqueID, "name": $0.localizedName, "isDefault": $0.uniqueID == def]
    }
}

/// Enable iPhone/iPad USB screen capture devices (task 11.4).
func enableIosScreenCapture() {
    var prop = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
                                         mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
}

func listIosDevices() -> [[String: Any]] {
    enableIosScreenCapture()
    return AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
}

// MARK: - Recording session

final class Session: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let bundle: URL
    let cfg: [String: Any]
    let t0 = hostNowNs()
    var stream: SCStream?
    var appAudioStream: SCStream?
    var writer: AVAssetWriter?
    var videoIn: AVAssetWriterInput?
    var sysWriter: AVAssetWriter?
    var sysIn: AVAssetWriterInput?
    var micSession: AVCaptureSession?
    var micWriter: AVAssetWriter?
    var micIn: AVAssetWriterInput?
    var micMuted = false
    var segments: [[String: Any]] = []
    var micFiles: [String] = []
    var sysFiles: [String] = []
    var segStartNs: Int64 = 0
    var lastVideoNs: Int64 = 0
    var size = CGSize(width: 1920, height: 1080)
    var scale: Double = 2
    var state = "idle"
    var input: InputRecorder?
    let q = DispatchQueue(label: "capture")

    init(bundle: URL, cfg: [String: Any]) { self.bundle = bundle; self.cfg = cfg }

    func start() async throws {
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("media"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("events"), withIntermediateDirectories: true)
        let lock: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "t0Ns": t0]
        try JSONSerialization.data(withJSONObject: lock).write(to: bundle.appendingPathComponent("recording.lock"))
        if (cfg["captureInput"] as? Bool) ?? true {
            input = InputRecorder(dir: bundle.appendingPathComponent("events"), t0: t0, origin: origin)
            input?.start()
        }
        try await beginSegment()
        state = "recording"
    }

    var originPt = CGPoint.zero
    func origin() -> CGPoint { originPt }

    private func makeFilter() async throws -> (SCContentFilter, CGRect?) {
        let content = try await shareable()
        let me = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier || ((cfg["excludePids"] as? [Int32]) ?? []).contains($0.processID) }
        let mode = cfg["mode"] as? String ?? "display"
        let displayId = UInt32(cfg["displayId"] as? String ?? "") ?? CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == displayId }) ?? content.displays.first else { throw RpcError(code: -32010, message: "no display") }
        scale = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) == display.displayID }?.backingScaleFactor ?? 2
        if mode == "window", let wid = UInt32(cfg["windowId"] as? String ?? ""), let w = content.windows.first(where: { $0.windowID == wid }) {
            size = CGSize(width: w.frame.width * scale, height: w.frame.height * scale)
            originPt = CGPoint(x: w.frame.origin.x * scale, y: w.frame.origin.y * scale)
            return (SCContentFilter(desktopIndependentWindow: w), nil)
        }
        // hide Finder desktop icons / Dock non-invasively (task 2.8)
        var excludedWindows: [SCWindow] = []
        if (cfg["hideDesktopIcons"] as? Bool) == true { excludedWindows += content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.apple.finder" && $0.windowLayer < 0 } }
        if (cfg["hideDock"] as? Bool) == true { excludedWindows += content.windows.filter { $0.owningApplication?.bundleIdentifier == "com.apple.dock" } }
        let filter = SCContentFilter(display: display, excludingApplications: me, exceptingWindows: excludedWindows.isEmpty ? [] : [])
        if mode == "area", let a = cfg["area"] as? [String: Double] {
            let r = CGRect(x: (a["x"] ?? 0) / scale - display.frame.origin.x, y: (a["y"] ?? 0) / scale - display.frame.origin.y, width: (a["width"] ?? 100) / scale, height: (a["height"] ?? 100) / scale)
            size = CGSize(width: (r.width * scale).rounded(.down) / 2 * 2, height: (r.height * scale).rounded(.down) / 2 * 2)
            originPt = CGPoint(x: a["x"] ?? 0, y: a["y"] ?? 0)
            return (filter, r)
        }
        size = CGSize(width: Double(display.width) * scale, height: Double(display.height) * scale)
        originPt = CGPoint(x: display.frame.origin.x * scale, y: display.frame.origin.y * scale)
        return (filter, nil)
    }

    func beginSegment() async throws {
        let idx = segments.count
        let (filter, rect) = try await makeFilter()
        let conf = SCStreamConfiguration()
        conf.width = Int(size.width); conf.height = Int(size.height)
        if let rect { conf.sourceRect = rect }
        let fps = cfg["fps"] as? Int ?? 60
        conf.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        conf.showsCursor = false // clean screen — the cursor is re-rendered by the editor
        conf.capturesAudio = (cfg["systemAudio"] as? [String: Any])?["enabled"] as? Bool ?? false
        conf.excludesCurrentProcessAudio = true
        conf.sampleRate = 48000; conf.channelCount = 2
        conf.queueDepth = 8
        conf.pixelFormat = kCVPixelFormatType_32BGRA

        let file = "media/screen_\(String(format: "%03d", idx)).mp4"
        let w = try AVAssetWriter(outputURL: bundle.appendingPathComponent(file), fileType: .mp4)
        w.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600) // crash loses ≤ ~2 s
        let bitrate = Int(size.width * size.height * Double(fps) * 0.12)
        let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
                                                                           AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: fps * 2]])
        vin.expectsMediaDataInRealTime = true
        w.add(vin)
        writer = w; videoIn = vin
        if conf.capturesAudio {
            let sf = "media/system_\(String(format: "%03d", idx)).wav"
            let sw = try AVAssetWriter(outputURL: bundle.appendingPathComponent(sf), fileType: .wav)
            let sin = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
            sin.expectsMediaDataInRealTime = true
            sw.add(sin)
            sysWriter = sw; sysIn = sin; sysFiles.append(sf)
        }
        if (cfg["mic"] as? [String: Any])?["enabled"] as? Bool == true { try startMic(idx: idx) }
        let s = SCStream(filter: filter, configuration: conf, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        // per-app audio (REC-07): a second audio-only stream limited to the selected app
        if let pid = (cfg["systemAudio"] as? [String: Any])?["appPid"] as? Int32, let app = try await shareable().applications.first(where: { $0.processID == pid }) {
            let content = try await shareable()
            let af = SCContentFilter(display: content.displays[0], including: [app], exceptingWindows: [])
            let ac = SCStreamConfiguration(); ac.capturesAudio = true; ac.sampleRate = 48000; ac.channelCount = 2; ac.width = 2; ac.height = 2
            let a = SCStream(filter: af, configuration: ac, delegate: self)
            try a.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
            try await a.startCapture()
            appAudioStream = a
        } else if conf.capturesAudio {
            try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: q)
        }
        segStartNs = hostNowNs() - t0
        segments.append(["file": file, "startNs": segStartNs, "durationNs": 0])
        writeJournal()
        try await s.startCapture()
        stream = s
        input?.paused = false
    }

    func startMic(idx: Int) throws {
        let s = AVCaptureSession()
        let devId = (cfg["mic"] as? [String: Any])?["deviceId"] as? String
        guard let dev = (devId.flatMap { AVCaptureDevice(uniqueID: $0) }) ?? AVCaptureDevice.default(for: .audio) else { return }
        s.addInput(try AVCaptureDeviceInput(device: dev))
        let out = AVCaptureAudioDataOutput()
        out.setSampleBufferDelegate(self, queue: q)
        s.addOutput(out)
        let mf = "media/mic_\(String(format: "%03d", idx)).wav"
        let mw = try AVAssetWriter(outputURL: bundle.appendingPathComponent(mf), fileType: .wav)
        let min = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
        min.expectsMediaDataInRealTime = true
        mw.add(min)
        micWriter = mw; micIn = min; micSession = s; micFiles.append(mf)
        s.startRunning()
    }

    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid else { return }
        if type == .screen {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let statusRaw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: statusRaw) == .complete else { return }
            guard let w = writer, let vin = videoIn else { return }
            if w.status == .unknown { w.startWriting(); w.startSession(atSourceTime: sb.presentationTimeStamp); sysWriter?.startWriting(); sysWriter?.startSession(atSourceTime: sb.presentationTimeStamp); micWriter?.startWriting(); micWriter?.startSession(atSourceTime: sb.presentationTimeStamp) }
            if vin.isReadyForMoreMediaData { vin.append(sb) } else { notify("frameDrop", ["behind": 1]) }
            lastVideoNs = Int64(sb.presentationTimeStamp.seconds * 1e9)
        } else if type == .audio, let sin = sysIn, sysWriter?.status == .writing, sin.isReadyForMoreMediaData {
            sin.append(sb)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let min = micIn, micWriter?.status == .writing, min.isReadyForMoreMediaData else { return }
        if micMuted, let block = CMSampleBufferGetDataBuffer(sb) {
            var len = 0; var ptr: UnsafeMutablePointer<Int8>?
            CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
            if let ptr { memset(ptr, 0, len) }
        }
        min.append(sb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { notify("error", ["source": "screen", "message": error.localizedDescription]) }

    func endSegment() async {
        input?.paused = true
        try? await stream?.stopCapture(); stream = nil
        try? await appAudioStream?.stopCapture(); appAudioStream = nil
        micSession?.stopRunning(); micSession = nil
        videoIn?.markAsFinished(); sysIn?.markAsFinished(); micIn?.markAsFinished()
        await writer?.finishWriting(); await sysWriter?.finishWriting(); await micWriter?.finishWriting()
        writer = nil; sysWriter = nil; micWriter = nil
        let dur = max(0, hostNowNs() - t0 - segStartNs)
        segments[segments.count - 1]["durationNs"] = dur
        writeJournal()
    }

    func writeJournal() {
        let j: [String: Any] = ["segments": segments, "mic": micFiles, "system": sysFiles, "width": size.width, "height": size.height, "fps": cfg["fps"] as? Int ?? 60, "scaleFactor": scale]
        if let d = try? JSONSerialization.data(withJSONObject: j) { try? d.write(to: bundle.appendingPathComponent("segments.json"), options: .atomic) }
    }

    func stop() async -> [String: Any] {
        if state == "recording" { await endSegment() }
        input?.stop()
        state = "idle"
        return ["segments": segments, "audio": ["mic": micFiles, "system": sysFiles], "width": size.width, "height": size.height, "fps": cfg["fps"] as? Int ?? 60, "scaleFactor": scale]
    }
}

// MARK: - Input telemetry (task 1.7/1.8)

final class InputRecorder {
    let dir: URL; let t0: Int64; let origin: () -> CGPoint
    var paused = false
    var tap: CFMachPort?
    var timer: DispatchSourceTimer?
    var cursorFile: FileHandle?, clickFile: FileHandle?, keyFile: FileHandle?
    var lastShapeHash = 0, shapeIds: [Int: Int] = [:], nextShape = 100
    let semantic: [(NSCursor, Int)] = [(.arrow, 0), (.iBeam, 1), (.pointingHand, 2), (.crosshair, 3), (.resizeUpDown, 4), (.resizeLeftRight, 5), (.openHand, 8), (.closedHand, 8), (.operationNotAllowed, 9)]

    init(dir: URL, t0: Int64, origin: @escaping () -> CGPoint) { self.dir = dir; self.t0 = t0; self.origin = origin }

    func open(_ name: String) -> FileHandle? {
        let u = dir.appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: u.path) { FileManager.default.createFile(atPath: u.path, contents: nil) }
        let h = try? FileHandle(forWritingTo: u); h?.seekToEndOfFile(); return h
    }

    func start() {
        cursorFile = open("cursor.bin"); clickFile = open("clicks.jsonl"); keyFile = open("keys.jsonl")
        try? FileManager.default.createDirectory(at: dir.appendingPathComponent("cursors"), withIntermediateDirectories: true)
        let mask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.leftMouseUp.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.rightMouseUp.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let me = Unmanaged.passUnretained(self).toOpaque()
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: CGEventMask(mask), callback: { _, type, event, ref in
            let s = Unmanaged<InputRecorder>.fromOpaque(ref!).takeUnretainedValue()
            s.onEvent(type, event); return Unmanaged.passUnretained(event)
        }, userInfo: me)
        if let tap { let src = CFMachPortCreateRunLoopSource(nil, tap, 0); CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes); CGEvent.tapEnable(tap: tap, enable: true) }
        else { notify("error", ["source": "input", "message": "Accessibility / Input Monitoring permission is required for click and keyboard tracking"]) }
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "cursor-poll", qos: .userInteractive))
        t.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / 120))
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume(); timer = t
    }

    func toPixels(_ p: CGPoint) -> CGPoint {
        // NSEvent coords are bottom-left points → top-left pixels relative to the capture origin
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let o = origin()
        return CGPoint(x: p.x * scale - o.x, y: (screenH - p.y) * scale - o.y)
    }

    func poll() {
        guard !paused else { return }
        let p = toPixels(NSEvent.mouseLocation)
        let shape = currentShape()
        var rec = Data(capacity: 18)
        var t = (hostNowNs() - t0).littleEndian, x = Float(p.x), y = Float(p.y), s = UInt16(shape).littleEndian
        rec.append(Data(bytes: &t, count: 8)); rec.append(Data(bytes: &x, count: 4)); rec.append(Data(bytes: &y, count: 4)); rec.append(Data(bytes: &s, count: 2))
        cursorFile?.write(rec)
    }

    func currentShape() -> Int {
        guard let c = NSCursor.currentSystem else { return 0 }
        let hash = c.image.tiffRepresentation?.hashValue ?? 0
        if let known = shapeIds[hash] { return known }
        let sem = semantic.first { $0.0.image.tiffRepresentation?.hashValue == hash }?.1
        let id = sem ?? { nextShape += 1; return nextShape - 1 }()
        shapeIds[hash] = id
        if sem == nil, let tiff = c.image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: dir.appendingPathComponent("cursors/\(id).png"))
            try? "{\"hotspot\":[\(Int(c.hotSpot.x)),\(Int(c.hotSpot.y))],\"semantic\":\"custom\",\"size\":\(Int(c.image.size.width))}".write(to: dir.appendingPathComponent("cursors/\(id).json"), atomically: true, encoding: .utf8)
        }
        return id
    }

    func onEvent(_ type: CGEventType, _ e: CGEvent) {
        guard !paused else { return }
        let t = hostNowNs() - t0
        switch type {
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp:
            let flipped = toPixels(NSEvent.mouseLocation)
            let button = (type == .leftMouseDown || type == .leftMouseUp) ? "left" : "right"
            let phase = (type == .leftMouseDown || type == .rightMouseDown) ? "down" : "up"
            clickFile?.write("{\"t\":\(t),\"x\":\(flipped.x),\"y\":\(flipped.y),\"button\":\"\(button)\",\"phase\":\"\(phase)\"}\n".data(using: .utf8)!)
        case .keyDown:
            let f = e.flags
            var mods: [String] = []
            if f.contains(.maskCommand) { mods.append("Meta") }; if f.contains(.maskControl) { mods.append("Ctrl") }
            if f.contains(.maskAlternate) { mods.append("Alt") }; if f.contains(.maskShift) { mods.append("Shift") }
            let combo = mods.contains("Meta") || mods.contains("Ctrl") || mods.contains("Alt")
            let code = KeyCodes.map[Int(e.getIntegerValueField(.keyboardEventKeycode))] ?? "Unknown"
            let printable = KeyCodes.printable.contains(code)
            let modsJson = "[" + mods.map { "\"\($0)\"" }.joined(separator: ",") + "]"
            // privacy (§5.1): plain typing is stored without the key code
            let line = printable && !combo ? "{\"t\":\(t),\"mods\":\(modsJson),\"phase\":\"down\",\"printable\":true}\n" : "{\"t\":\(t),\"code\":\"\(code)\",\"mods\":\(modsJson),\"phase\":\"down\",\"printable\":false}\n"
            keyFile?.write(line.data(using: .utf8)!)
        default: break
        }
    }

    func stop() {
        timer?.cancel()
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        try? cursorFile?.synchronize(); try? clickFile?.synchronize(); try? keyFile?.synchronize()
    }
}

enum KeyCodes {
    static let map: [Int: String] = [0: "KeyA", 11: "KeyB", 8: "KeyC", 2: "KeyD", 14: "KeyE", 3: "KeyF", 5: "KeyG", 4: "KeyH", 34: "KeyI", 38: "KeyJ", 40: "KeyK", 37: "KeyL", 46: "KeyM", 45: "KeyN", 31: "KeyO", 35: "KeyP", 12: "KeyQ", 15: "KeyR", 1: "KeyS", 17: "KeyT", 32: "KeyU", 9: "KeyV", 13: "KeyW", 7: "KeyX", 16: "KeyY", 6: "KeyZ",
        29: "Digit0", 18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 23: "Digit5", 22: "Digit6", 26: "Digit7", 28: "Digit8", 25: "Digit9",
        36: "Enter", 53: "Escape", 48: "Tab", 51: "Backspace", 117: "Delete", 49: "Space", 123: "ArrowLeft", 124: "ArrowRight", 125: "ArrowDown", 126: "ArrowUp",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10", 103: "F11", 111: "F12",
        27: "Minus", 24: "Equal", 33: "BracketLeft", 30: "BracketRight", 41: "Semicolon", 39: "Quote", 43: "Comma", 47: "Period", 44: "Slash", 42: "Backslash", 50: "Backquote", 115: "Home", 119: "End", 116: "PageUp", 121: "PageDown"]
    static let printable: Set<String> = Set(map.values.filter { $0.hasPrefix("Key") || $0.hasPrefix("Digit") }).union(["Space", "Minus", "Equal", "BracketLeft", "BracketRight", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backslash", "Backquote"])
}

// MARK: - Dispatch

var session: Session?

func handle(_ method: String, _ p: [String: Any]) async throws -> Any {
    switch method {
    case "ping": return ["pong": true, "t": hostNowNs()]
    case "version": return ["version": "0.1.0", "platform": "darwin", "engine": "ScreenCaptureKit", "encoder": "videotoolbox"]
    case "listDisplays": return try await listDisplays()
    case "listWindows": return try await listWindows(exclude: Set((p["excludePids"] as? [Int32]) ?? []))
    case "listAudioInputs": return listAudioInputs()
    case "listAudioOutputs": return [["id": "default", "name": "System audio", "isDefault": true]]
    case "listAudioApps": return try await shareable().applications.filter { !$0.applicationName.isEmpty }.map { ["pid": $0.processID, "name": $0.applicationName] }
    case "listIosDevices": return listIosDevices()
    case "startRecording":
        guard session == nil || session?.state == "idle", let dir = p["bundleDir"] as? String else { throw RpcError(code: -32020, message: "already recording") }
        let s = Session(bundle: URL(fileURLWithPath: dir), cfg: p)
        try await s.start(); session = s
        return ["state": "recording"]
    case "pause": await session?.endSegment(); session?.state = "paused"; return ["state": "paused"]
    case "resume": try await session?.beginSegment(); session?.state = "recording"; return ["state": "recording"]
    case "stop":
        guard let s = session else { throw RpcError(code: -32020, message: "not recording") }
        let r = await s.stop(); session = nil; return r
    case "setMicMuted": session?.micMuted = (p["muted"] as? Bool) ?? false; return ["ok": true]
    case "status": return ["state": session?.state ?? "idle", "segment": (session?.segments.count ?? 0) - 1, "elapsedNs": 0, "droppedFrames": 0, "bytesWritten": 0]
    case "setDesktopClean": return ["iconsVisible": true, "taskbarAutoHide": false] // handled via SCK filter exclusions on macOS
    case "copyFileToClipboard":
        guard let path = p["path"] as? String else { throw RpcError(code: -32602, message: "path required") }
        await MainActor.run { NSPasteboard.general.clearContents(); NSPasteboard.general.writeObjects([URL(fileURLWithPath: path) as NSURL]) }
        return ["ok": true]
    case "startLevels", "stopLevels": return ["ok": true]
    default: throw RpcError(code: -32601, message: "method not found: \(method)")
    }
}

log("info", "helper.start", ["pid": ProcessInfo.processInfo.processIdentifier])
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let method = req["method"] as? String else { continue }
        let id = req["id"]
        let params = req["params"] as? [String: Any] ?? [:]
        Task {
            do {
                let r = try await handle(method, params)
                if let id { send(["jsonrpc": "2.0", "id": id, "result": r]) }
            } catch let e as RpcError {
                if let id { send(["jsonrpc": "2.0", "id": id, "error": ["code": e.code, "message": e.message]]) }
            } catch {
                if let id { send(["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": error.localizedDescription]]) }
            }
        }
    }
    Task { _ = await session?.stop(); exit(0) } // stdin closed → finalise and exit
}
RunLoop.main.run()
