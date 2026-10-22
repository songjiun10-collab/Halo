// Test-only window for the OS helper: a text field, a secure field and two buttons. Every event is appended
// to the file named by HALO_TESTAPP_LOG so a test can see exactly what reached the app.
import AppKit

let logPath = ProcessInfo.processInfo.environment["HALO_TESTAPP_LOG"] ?? "/tmp/halo-testapp.log"
func log(_ line: String) {
    if let h = FileHandle(forWritingAtPath: logPath) { h.seekToEndOfFile(); h.write((line + "\n").data(using: .utf8)!); h.closeFile() }
    else { try? (line + "\n").write(toFile: logPath, atomically: true, encoding: .utf8) }
}

final class Target: NSObject, NSTextFieldDelegate {
    @objc func open(_ s: Any?) { log("click:Open") }
    @objc func del(_ s: Any?) { log("click:Delete note") }
    func controlTextDidChange(_ n: Notification) { if let f = n.object as? NSTextField { log("text:\(f.stringValue)") } }
}
let target = Target()
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 300, width: 480, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Halo Test App"
let view = window.contentView!
let field = NSTextField(frame: NSRect(x: 20, y: 240, width: 440, height: 24)); field.placeholderString = "Body"; field.delegate = target
let secure = NSSecureTextField(frame: NSRect(x: 20, y: 200, width: 440, height: 24)); secure.placeholderString = "Password"
let openButton = NSButton(title: "Open", target: target, action: #selector(Target.open(_:))); openButton.frame = NSRect(x: 20, y: 140, width: 120, height: 32)
let deleteButton = NSButton(title: "Delete note", target: target, action: #selector(Target.del(_:))); deleteButton.frame = NSRect(x: 160, y: 140, width: 140, height: 32)
[field, secure, openButton, deleteButton].forEach { view.addSubview($0) }
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(field)
app.activate(ignoringOtherApps: true)
app.run()
