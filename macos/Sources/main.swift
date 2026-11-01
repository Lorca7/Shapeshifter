// Shapeshifter for macOS.
//
// A native AppKit application: real window, real menu bar, real Open and Save
// panels, real pasteboard. The editing engine itself is the same tested
// JavaScript the web build uses, hosted in a WKWebView and served from inside
// the app bundle over a private URL scheme.
//
// Serving over a custom scheme rather than file:// is what allows the engine's
// ES modules to load, and it means the app needs no local web server and makes
// no network connections of any kind.

import AppKit
import UniformTypeIdentifiers
import WebKit

let kScheme = "shapeshifter"
let kHost = "app"
let kAppName = "Shapeshifter"
/// The name the page posts messages to: window.webkit.messageHandlers.shapeshifter
let kBridgeName = "shapeshifter"

// MARK: - Handing files between Swift and the page

/// Short-lived store for bytes moving between the app and the web view.
/// Opening a photo puts its data here and the page fetches it over the app's
/// own URL scheme, so a 40-megapixel TIFF never has to cross the bridge as a
/// base64 string.
final class TransferStore {
    private var items: [String: (data: Data, mime: String)] = [:]
    private let lock = NSLock()

    func put(_ data: Data, mime: String) -> String {
        let id = UUID().uuidString
        lock.lock()
        items[id] = (data, mime)
        lock.unlock()
        return id
    }

    func take(_ id: String) -> (data: Data, mime: String)? {
        lock.lock()
        defer { lock.unlock() }
        return items.removeValue(forKey: id)
    }
}

// MARK: - Serving the bundled editor

final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let transfers: TransferStore

    init(root: URL, transfers: TransferStore) {
        self.root = root
        self.transfers = transfers
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        // A one-shot handoff of a file the user just opened.
        if path.hasPrefix("/__transfer/") {
            let id = String(path.dropFirst("/__transfer/".count))
            guard let item = transfers.take(id) else {
                task.didFailWithError(URLError(.resourceUnavailable))
                return
            }
            respond(task: task, url: url, data: item.data, mime: item.mime)
            return
        }

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
    private let transfers = TransferStore()
    /// Files asked for before the editor had finished loading.
    private var queuedFiles: [URL] = []
    private var ready = false

    // MARK: Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            fail("This copy of \(kAppName) is missing its editor files. Rebuild it with macos/build.sh.")
            return
        }

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(AssetSchemeHandler(root: root, transfers: transfers), forURLScheme: kScheme)
        configuration.userContentController.add(self, name: kBridgeName)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1340, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = kAppName
        window.minSize = NSSize(width: 960, height: 620)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.07, blue: 0.09, alpha: 1)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.center()
        // Setting the autosave name restores a previously saved frame, so this
        // has to come after center(): centred on first run, remembered after.
        window.setFrameAutosaveName("ShapeshifterMainWindow")
        window.makeKeyAndOrderFront(nil)

        buildMenu()

        let start = URL(string: "\(kScheme)://\(kHost)/index.html")!
        webView.load(URLRequest(url: start))

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Files dropped on the Dock icon, or opened with "Open With".
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
        fileMenu.addItem(.separator())
        add(to: fileMenu, "Export Shape…", #selector(exportShape(_:)), "e")
        add(to: fileMenu, "Copy Cut-Out", #selector(copyCutout(_:)), "c", [.command, .shift])
        fileMenu.addItem(.separator())
        _ = fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        add(to: editMenu, "Undo", #selector(undoEdit(_:)), "z")
        add(to: editMenu, "Redo", #selector(redoEdit(_:)), "z", [.command, .shift])
        editMenu.addItem(.separator())
        add(to: editMenu, "Select All", #selector(selectAllShape(_:)), "a")
        add(to: editMenu, "Deselect", #selector(deselectShape(_:)), "d")
        add(to: editMenu, "Invert Selection", #selector(invertShape(_:)), "i")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        add(to: viewMenu, "Zoom In", #selector(zoomIn(_:)), "+")
        add(to: viewMenu, "Zoom Out", #selector(zoomOut(_:)), "-")
        add(to: viewMenu, "Actual Size", #selector(actualSize(_:)), "1")
        add(to: viewMenu, "Fit to Window", #selector(fitToWindow(_:)), "0")
        viewMenu.addItem(.separator())
        let full = viewMenu.addItem(withTitle: "Enter Full Screen",
                                    action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        full.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        let helpItem = NSMenuItem()
        mainMenu.addItem(helpItem)
        let helpMenu = NSMenu(title: "Help")
        add(to: helpMenu, "Keyboard Shortcuts", #selector(showShortcuts(_:)), "?")
        helpItem.submenu = helpMenu

        NSApp.mainMenu = mainMenu
        NSApp.helpMenu = helpMenu
    }

    @discardableResult
    private func add(to menu: NSMenu, _ title: String, _ action: Selector, _ key: String,
                     _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.target = self
        return item
    }

    // MARK: Menu actions

    @objc func openDocument(_ sender: Any?) { presentOpenPanel() }
    @objc func exportShape(_ sender: Any?) { run("window.shapeshifter.editor.export()") }
    @objc func copyCutout(_ sender: Any?) { run("window.shapeshifter.editor.copyToClipboard()") }
    @objc func undoEdit(_ sender: Any?) { run("window.shapeshifter.editor.undo()") }
    @objc func redoEdit(_ sender: Any?) { run("window.shapeshifter.editor.redo()") }
    @objc func selectAllShape(_ sender: Any?) { run("window.shapeshifter.editor.selectAll()") }
    @objc func deselectShape(_ sender: Any?) { run("window.shapeshifter.editor.selectNone()") }
    @objc func invertShape(_ sender: Any?) { run("window.shapeshifter.editor.invert()") }
    @objc func zoomIn(_ sender: Any?) { run("window.shapeshifter.editor.zoomBy(1.25)") }
    @objc func zoomOut(_ sender: Any?) { run("window.shapeshifter.editor.zoomBy(0.8)") }
    @objc func actualSize(_ sender: Any?) { run("window.shapeshifter.editor.setZoom(1)") }
    @objc func fitToWindow(_ sender: Any?) { run("window.shapeshifter.editor.fit()") }
    @objc func showShortcuts(_ sender: Any?) { run("document.getElementById('helpDialog').showModal()") }

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
            presentSavePanel(data: data, suggestedName: name)
        case "clipboard":
            guard let encoded = body["data"] as? String,
                  let data = Data(base64Encoded: encoded) else { return }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            // PNG keeps the transparency exactly; TIFF is there for the apps
            // that only look for it.
            pasteboard.setData(data, forType: .png)
            if let tiff = NSImage(data: data)?.tiffRepresentation {
                pasteboard.setData(tiff, forType: .tiff)
            }
        default:
            break
        }
    }

    // MARK: Panels

    private func presentOpenPanel() {
        let panel = NSOpenPanel()
        panel.title = "Open a photo"
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
        panel.title = "Export the shape"
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        let ext = (suggestedName as NSString).pathExtension
        if let type = UTType(filenameExtension: ext) { panel.allowedContentTypes = [type] }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url, options: .atomic)
                self.report("Saved \(url.lastPathComponent) to \(url.deletingLastPathComponent().lastPathComponent).")
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
        // Sandboxed or not, a file picked by the user may need explicit access.
        let scoped = fileURL.startAccessingSecurityScopedResource()
        defer { if scoped { fileURL.stopAccessingSecurityScopedResource() } }

        guard let data = try? Data(contentsOf: fileURL) else {
            report("Could not read \(fileURL.lastPathComponent).", isError: true)
            return
        }
        let mime = AssetSchemeHandler.mimeType(for: fileURL.pathExtension)
        let id = transfers.put(data, mime: mime)
        run("window.__shapeshifterOpenTransfer(\(quote(id)), \(quote(fileURL.lastPathComponent)), \(quote(mime)))")
    }

    // MARK: Navigation policy

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        let pending = queuedFiles
        queuedFiles.removeAll()
        for url in pending { open(fileURL: url) }
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // A photo dragged into the window that the page did not consume would
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
        // Anything else is an outside link: hand it to the default browser.
        if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: Talking to the page

    private func run(_ script: String) {
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    /// Show a message on the editor's own status bar.
    private func report(_ message: String, isError: Bool = false) {
        run("window.shapeshifter.editor.setStatus(\(quote(message)), \(quote(isError ? "error" : "")))")
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
