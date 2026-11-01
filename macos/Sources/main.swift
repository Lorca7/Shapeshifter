// Shapeshifter for macOS.
//
// A native AppKit application: a real window, menu bar, Open and Save panels.
// The editor itself is web code hosted in a WKWebView and served from inside
// the app bundle over a private URL scheme, so the app runs no local server and
// makes no network connections of any kind.
//
// Running the app with SHAPESHIFTER_SELFTEST_PHOTO and SHAPESHIFTER_SELFTEST_OUTPUT
// set makes it open that photo, trace an outline, save through the same path the
// Save panel uses, write the result to the output path and exit. That is how the
// build proves the real app works, not just that it launches.

import AppKit
import UniformTypeIdentifiers
import WebKit

let kScheme = "shapeshifter"
let kHost = "app"
let kAppName = "Shapeshifter"
/// The name the page posts messages to: window.webkit.messageHandlers.shapeshifter
let kBridgeName = "shapeshifter"

// MARK: - Serving the bundled editor

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let fileURL = URL(fileURLWithPath: root.path + path).standardizedFileURL
        // Never serve anything outside the bundle's web folder.
        guard fileURL.path.hasPrefix(root.path), let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        respond(task: task, url: url, data: data, mime: AssetSchemeHandler.mimeType(for: fileURL.pathExtension))
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func respond(task: WKURLSchemeTask, url: URL, data: Data, mime: String) {
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "tif", "tiff": return "image/tiff"
        case "webp": return "image/webp"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - The application

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    /// Photos asked for before the editor had finished loading.
    private var queuedFiles: [URL] = []
    private var ready = false

    private let environment = ProcessInfo.processInfo.environment
    private var selfTestPhoto: String? { environment["SHAPESHIFTER_SELFTEST_PHOTO"] }
    private var selfTestOutput: String? { environment["SHAPESHIFTER_SELFTEST_OUTPUT"] }
    private var isSelfTest: Bool { selfTestPhoto != nil && selfTestOutput != nil }

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            fail("This copy of \(kAppName) is missing its editor files. Rebuild it with macos/build.sh.")
            return
        }

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(AssetSchemeHandler(root: root), forURLScheme: kScheme)
        configuration.userContentController.add(self, name: kBridgeName)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = kAppName
        window.minSize = NSSize(width: 820, height: 560)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.07, blue: 0.09, alpha: 1)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        // Restores a saved frame, so this comes after center(): centred on the
        // first run, remembered after that.
        window.setFrameAutosaveName("ShapeshifterMainWindow")
        window.makeKeyAndOrderFront(nil)

        buildMenu()
        webView.load(URLRequest(url: URL(string: "\(kScheme)://\(kHost)/index.html")!))
        NSApp.activate(ignoringOtherApps: true)

        if isSelfTest {
            // If anything below stalls, fail loudly instead of hanging the build.
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                self?.failSelfTest("timed out before a cutout was saved")
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Photos dropped on the Dock icon, or opened with "Open With".
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { open(fileURL: url) }
    }

    // MARK: Menus

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        _ = appMenu.addItem(withTitle: "About \(kAppName)",
                            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        _ = appMenu.addItem(withTitle: "Hide \(kAppName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others",
                                         action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        _ = appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        _ = appMenu.addItem(withTitle: "Quit \(kAppName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        add(to: fileMenu, "Open Photo…", #selector(openDocument(_:)), "o")
        add(to: fileMenu, "Save Cutout…", #selector(saveCutout(_:)), "s")
        fileMenu.addItem(.separator())
        _ = fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        add(to: editMenu, "Undo", #selector(undoEdit(_:)), "z")
        add(to: editMenu, "Redo", #selector(redoEdit(_:)), "z", [.command, .shift])
        editMenu.addItem(.separator())
        add(to: editMenu, "Start Over", #selector(startOver(_:)), "")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        add(to: viewMenu, "Zoom In", #selector(zoomIn(_:)), "+")
        add(to: viewMenu, "Zoom Out", #selector(zoomOut(_:)), "-")
        add(to: viewMenu, "Fit to Window", #selector(fitToWindow(_:)), "0")
        viewMenu.addItem(.separator())
        let full = viewMenu.addItem(withTitle: "Enter Full Screen",
                                    action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    @discardableResult
    private func add(to menu: NSMenu, _ title: String, _ action: Selector, _ key: String,
                     _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = key.isEmpty ? [] : modifiers
        item.target = self
        return item
    }

    // MARK: Menu actions

    @objc func openDocument(_ sender: Any?) { presentOpenPanel() }
    @objc func saveCutout(_ sender: Any?) { run("window.shapeshifter.save()") }
    @objc func undoEdit(_ sender: Any?) { run("window.shapeshifter.undo()") }
    @objc func redoEdit(_ sender: Any?) { run("window.shapeshifter.redo()") }
    @objc func startOver(_ sender: Any?) { run("window.shapeshifter.startOver()") }
    @objc func zoomIn(_ sender: Any?) { run("window.shapeshifter.zoomBy(1.4)") }
    @objc func zoomOut(_ sender: Any?) { run("window.shapeshifter.zoomBy(0.7)") }
    @objc func fitToWindow(_ sender: Any?) { run("window.shapeshifter.fit()") }

    // MARK: Messages from the page

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "open":
            presentOpenPanel()
        case "save":
            guard let name = body["filename"] as? String,
                  let encoded = body["data"] as? String,
                  let data = Data(base64Encoded: encoded) else { return }
            if let output = selfTestOutput {
                finishSelfTestSave(data: data, to: output)
            } else {
                presentSavePanel(data: data, suggestedName: name)
            }
        case "ready":
            pageIsReady()
        case "log":
            if isSelfTest, let text = body["message"] as? String { print("page: \(text)") }
        default:
            break
        }
    }

    // MARK: Panels

    private func presentOpenPanel() {
        let panel = NSOpenPanel()
        panel.title = "Choose a photo"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        var types: [UTType] = [.jpeg, .png, .tiff]
        if let webp = UTType("org.webmproject.webp") { types.append(webp) }
        panel.allowedContentTypes = types
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.open(fileURL: url)
        }
    }

    private func presentSavePanel(data: Data, suggestedName: String) {
        let panel = NSSavePanel()
        panel.title = "Save the cutout"
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        panel.allowedContentTypes = [.png]
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            guard response == .OK, let url = panel.url else {
                self.report("Not saved. Your outline is still here.")
                return
            }
            do {
                try data.write(to: url, options: .atomic)
                self.report("Saved \(url.lastPathComponent).")
            } catch {
                self.report("Could not save the file: \(error.localizedDescription)", isError: true)
            }
        }
    }

    // MARK: Opening a photo

    private func open(fileURL: URL) {
        guard ready else {
            queuedFiles.append(fileURL)
            return
        }
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }

        guard let data = try? Data(contentsOf: fileURL) else {
            report("Could not read \(fileURL.lastPathComponent).", isError: true)
            return
        }
        let name = fileURL.lastPathComponent
        let mime = AssetSchemeHandler.mimeType(for: fileURL.pathExtension)
        // callAsyncJavaScript waits for the page to finish opening the photo and
        // reports what went wrong, so a failure becomes a message, not silence.
        webView.callAsyncJavaScript(
            "await window.__openPhoto(data, name, type)",
            arguments: ["data": data.base64EncodedString(), "name": name, "type": mime],
            in: nil, in: .page
        ) { [weak self] result in
            guard case .failure(let error) = result else { return }
            let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
                ?? error.localizedDescription
            if self?.isSelfTest == true { print("page: could not open \(name): \(detail)") }
            self?.report("Could not open \(name): \(detail)", isError: true)
        }
    }

    // MARK: Navigation policy

    /// The editor has started and its entry points exist. Loading finishing is
    /// not enough: the editor's own scripts run just after the page loads, so
    /// a photo handed over any earlier finds nothing to receive it.
    private func pageIsReady() {
        guard !ready else { return }
        ready = true
        let pending = queuedFiles
        queuedFiles.removeAll()
        for url in pending { open(fileURL: url) }

        if let photo = selfTestPhoto, isSelfTest {
            open(fileURL: URL(fileURLWithPath: photo))
            pollForPhoto(attempt: 0)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if isSelfTest { print("page: navigation failed: \(error)") }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if isSelfTest { print("page: could not load the editor: \(error)") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if isSelfTest { print("page: the web content process crashed") }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // A photo dropped on the window that the page did not take would
        // otherwise navigate away from the editor. Open it instead.
        if url.isFileURL {
            decisionHandler(.cancel)
            open(fileURL: url)
            return
        }
        if url.scheme == kScheme {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: Self-test

    private func pollForPhoto(attempt: Int) {
        webView.evaluateJavaScript("Boolean(window.shapeshifter) && window.shapeshifter.state().loaded") { [weak self] result, _ in
            guard let self else { return }
            if (result as? NSNumber)?.boolValue == true {
                // A 12-sided outline around the magenta disc in the test photo.
                let points = (0..<12).map { i -> String in
                    let angle = Double(i) / 12 * 2 * Double.pi
                    return String(format: "[%.3f,%.3f]", 100 + 36 * cos(angle), 75 + 36 * sin(angle))
                }.joined(separator: ",")
                self.run("window.shapeshifter.trace([\(points)]); window.shapeshifter.save()")
            } else if attempt < 80 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.pollForPhoto(attempt: attempt + 1) }
            } else {
                self.failSelfTest("the photo never opened in the app")
            }
        }
    }

    private func finishSelfTestSave(data: Data, to path: String) {
        let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47]
        guard data.count > 100, Array(data.prefix(4)) == pngSignature else {
            finishSelfTest(ok: false, "the app produced something that is not a PNG (\(data.count) bytes)")
            return
        }
        do {
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            finishSelfTest(ok: true, "opened a photo, traced an outline and saved a \(data.count)-byte PNG")
        } catch {
            finishSelfTest(ok: false, "could not write the result: \(error.localizedDescription)")
        }
    }

    private var selfTestFinished = false

    private func finishSelfTest(ok: Bool, _ message: String) {
        guard !selfTestFinished else { return }
        selfTestFinished = true
        let line = (ok ? "SELFTEST PASS: " : "SELFTEST FAIL: ") + message + "\n"
        FileHandle.standardOutput.write(Data(line.utf8))
        exit(ok ? 0 : 1)
    }

    /// Fail, saying what the page was doing, so a broken build explains itself.
    private func failSelfTest(_ reason: String) {
        let script = """
        const out = {
          app: typeof window.shapeshifter,
          openPhoto: typeof window.__openPhoto,
          scripts: document.scripts.length,
          hint: (document.getElementById('hint') || {}).textContent || null,
        };
        try { out.state = window.shapeshifter ? window.shapeshifter.state() : null; } catch (e) { out.stateError = String(e); }
        try { out.fetchCss = (await fetch('/css/app.css')).status; } catch (e) { out.fetchCss = String(e); }
        return JSON.stringify(out);
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            let detail: String
            switch result {
            case .success(let value): detail = String(describing: value)
            case .failure(let error): detail = "could not even inspect the page: \(error)"
            }
            self?.finishSelfTest(ok: false, "\(reason). Page state: \(detail)")
        }
        // If the page cannot answer at all, still fail rather than hang.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.finishSelfTest(ok: false, "\(reason). The page did not respond.")
        }
    }

    // MARK: Talking to the page

    private func run(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Show a message in the editor's own hint line.
    private func report(_ message: String, isError: Bool = false) {
        run("window.shapeshifter.setHint(\(quote(message)), \(quote(isError ? "error" : "")))")
    }

    /// JSON-quote a string so it is safe to paste into a script.
    private func quote(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    private func fail(_ message: String) {
        let alert = NSAlert()
        alert.messageText = kAppName
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
