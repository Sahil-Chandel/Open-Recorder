// swift-tools-version:5.9
// macOS capture helper (plan §1.2–1.8, 11.4). Same JSON-RPC 2.0 stdio protocol as the Windows helper.
// Build: swift build -c release  → .build/release/mac-helper (bundled into resources/bin/darwin-<arch>)
import PackageDescription

let package = Package(
    name: "mac-helper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "MacHelper",
            path: "Sources/MacHelper",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"), .linkedFramework("AVFoundation"), .linkedFramework("CoreMedia"),
                .linkedFramework("CoreMediaIO"), .linkedFramework("AppKit"), .linkedFramework("ApplicationServices"),
            ]
        ),
    ]
)