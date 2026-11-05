import Cocoa
import WebKit
import CryptoKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var console: Process?
    var readiness: Timer?
    var attempts = 0
    var sampling: Timer?
    var captured = false
    var readySamples = 0
    var lastCapture = Date.distantPast
    var dataRoot: URL!
    let origin = URL(string: "http://127.0.0.1:\(ProcessInfo.processInfo.environment["DQ_CONSOLE_PORT"] ?? "4783")")!
    var instanceID = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = Bundle.main.bundleURL.deletingLastPathComponent()
        dataRoot = root.appendingPathComponent(".local")
        let previous = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "ai.degenquest.playerbot").filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
        instanceID = SHA256.hash(data: Data(root.path.utf8)).map { String(format: "%02x", $0) }.joined().prefix(24).description
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Show Bot Console", action: #selector(showWindow), keyEquivalent: "0").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit DegenQuest Bot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 1000), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "DegenQuest Bot · This Mac"
        window.minSize = NSSize(width: 820, height: 650)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.backgroundColor = NSColor(red: 0.067, green: 0.09, blue: 0.086, alpha: 1)
        web = WKWebView(frame: .zero)
        web.navigationDelegate = self
        window.contentView = web
        window.center(); showWindow()
        web.loadHTMLString("<body style='background:#111716;color:#d6f58a;font:18px -apple-system;padding:50px'>Opening local bot console…</body>", baseURL: nil)
        let binaries = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = binaries.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { fail("Node 22 or newer is required on this Mac."); return }
        do {
            let logs = root.appendingPathComponent(".local")
            try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try Data(String(ProcessInfo.processInfo.processIdentifier).utf8).write(to: logs.appendingPathComponent("native-app.pid"), options: .atomic)
            let logURL = logs.appendingPathComponent("console.log")
            if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let handle = try FileHandle(forWritingTo: logURL); try handle.seekToEnd()
            let task = Process(); task.executableURL = URL(fileURLWithPath: node)
            task.arguments = [root.appendingPathComponent("bin/console.mjs").path]
            task.currentDirectoryURL = root
            task.standardOutput = handle; task.standardError = handle
            try task.run(); console = task
            readiness = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.checkReady() }
            sampling = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.sampleRender() }
            for older in previous { older.terminate() }
        } catch { fail("The local console could not start. See .local/console.log in the bot folder.") }
    }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func checkReady() {
        attempts += 1
        if attempts > 100 { readiness?.invalidate(); fail("The local console did not become ready. See .local/console.log in the bot folder."); return }
        var request = URLRequest(url: origin.appendingPathComponent("api/state")); request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self = self, let data = data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let runtime = json["runtime"] as? [String: Any], runtime["mode"] as? String == "local", runtime["instanceId"] as? String == self.instanceID else { return }
            DispatchQueue.main.async { if self.readiness?.isValid == true { self.readiness?.invalidate(); self.web.load(URLRequest(url: self.origin)) } }
        }.resume()
    }
    func fail(_ message: String) { let alert = NSAlert(); alert.messageText = "DegenQuest Bot"; alert.informativeText = message; alert.runModal() }
    func sampleRender() {
        let script = "JSON.stringify((()=>{const w=document.getElementById('game-preview')?.contentWindow;return {at:Date.now(),gpu:!!w?.navigator.gpu,frame:w?.__dqObserverFrame??null,status:w?.__dqObserverStatus??null,body:w?.document.body.innerText.slice(-1200)}})())"
        web.evaluateJavaScript(script) { [weak self] result, error in
            guard let self = self, let value = result as? String, let bytes = value.data(using: .utf8) else { return }
            try? bytes.write(to: self.dataRoot.appendingPathComponent("native-render-status.json"), options: .atomic)
            guard let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let frame = json["frame"] as? [String: Any], frame["firstPerson"] as? Bool == true, (frame["drawCalls"] as? Int ?? 0) > 0, let status = json["status"] as? [String: Any], status["ready"] as? Bool == true else { self.readySamples = 0; return }
            self.readySamples += 1
            // Allow React and the GPU compositor to present after loading clears.
            guard self.readySamples >= 2, !self.captured, Date().timeIntervalSince(self.lastCapture) >= 30 else { return }
            self.captured = true
            let configuration = WKSnapshotConfiguration(); configuration.afterScreenUpdates = true
            self.web.takeSnapshot(with: configuration) { image, error in
                self.captured = false
                guard let image = image, let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { self.captured = false; return }
                try? png.write(to: self.dataRoot.appendingPathComponent("native-first-person.png"), options: .atomic)
                self.lastCapture = Date()
            }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    // Start/Stop owns gameplay. Closing the app leaves the local controller
    // and its player running; reopening attaches to that same controller.
    func applicationWillTerminate(_ notification: Notification) { readiness?.invalidate(); sampling?.invalidate() }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == origin.port) ? .allow : .cancel)
    }
}
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
