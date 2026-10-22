// Halo OS helper: reads one JSON request per line on stdin, writes one JSON reply per line on stdout.
// It knows nothing about policy. It takes only coordinates, keys and text, and every input command names the
// app it expects in front; if another app is in front the command is refused. Needs the Accessibility
// permission (granted by the person in System Settings); it never changes any setting.
import AppKit
import ApplicationServices
import Foundation

func reply(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: []), let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}
func fail(_ id: Any?, _ code: String) { reply(["id": id as Any, "ok": false, "error": code]) }

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func pointOf(_ element: AXUIElement) -> CGPoint? {
    guard let raw = attr(element, kAXPositionAttribute as String) else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(raw as! AXValue, .cgPoint, &p) ? p : nil
}
func sizeOf(_ element: AXUIElement) -> CGSize? {
    guard let raw = attr(element, kAXSizeAttribute as String) else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(raw as! AXValue, .cgSize, &s) ? s : nil
}
func frameOf(_ element: AXUIElement) -> CGRect? {
    guard let p = pointOf(element), let s = sizeOf(element) else { return nil }
    return CGRect(origin: p, size: s)
}

let roleMap: [String: String] = [
    "AXButton": "button", "AXLink": "link", "AXTextField": "textbox", "AXTextArea": "textbox", "AXSecureTextField": "textbox",
    "AXSearchField": "searchbox", "AXCheckBox": "checkbox", "AXRadioButton": "radio", "AXMenuItem": "menuitem",
    "AXMenuButton": "button", "AXPopUpButton": "combobox", "AXComboBox": "combobox", "AXTab": "tab", "AXSlider": "slider",
]

// Failsafe: a person who holds Escape or moves the mouse after the last observation takes control back.
// Every input command checks this first, and the host stops for good on "user_interrupted".
var baseline: CGPoint? = nil
func currentMouse() -> CGPoint? { CGEvent(source: nil)?.location }
func userInterrupted() -> Bool {
    if CGEventSource.keyState(.combinedSessionState, key: 53) { return true }
    if let base = baseline, let now = currentMouse(), hypot(Double(now.x - base.x), Double(now.y - base.y)) > 8 { return true }
    return false
}

func frontApp() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

func focusedWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    if let w = attr(element, kAXFocusedWindowAttribute as String) { return (w as! AXUIElement) }
    if let w = attr(element, kAXMainWindowAttribute as String) { return (w as! AXUIElement) }
    return nil
}

func collect(_ element: AXUIElement, window: CGRect, focused: AXUIElement?, depth: Int, into out: inout [[String: Any]]) {
    if out.count >= 120 || depth > 12 { return }
    let axRole = (attr(element, kAXRoleAttribute as String) as? String) ?? ""
    let subrole = (attr(element, kAXSubroleAttribute as String) as? String) ?? ""
    if let role = roleMap[axRole], let frame = frameOf(element), frame.width > 0, frame.height > 0, window.width > 0, window.height > 0 {
        let name = (attr(element, kAXTitleAttribute as String) as? String)
            ?? (attr(element, kAXDescriptionAttribute as String) as? String)
            ?? (attr(element, kAXPlaceholderValueAttribute as String) as? String) ?? ""
        let secure = axRole == "AXSecureTextField" || subrole == "AXSecureTextField"
        var entry: [String: Any] = [
            "role": role, "name": String(name.prefix(80)),
            "x": min(max(Double((frame.minX - window.minX) / window.width), 0), 0.999),
            "y": min(max(Double((frame.minY - window.minY) / window.height), 0), 0.999),
            "w": min(Double(frame.width / window.width), 1), "h": min(Double(frame.height / window.height), 1),
        ]
        if secure { entry["secure"] = true }
        if let f = focused, CFEqual(f, element) { entry["focused"] = true }
        if let enabled = attr(element, kAXEnabledAttribute as String) as? Bool, !enabled { entry["disabled"] = true }
        out.append(entry)
    }
    if let children = attr(element, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children { collect(child, window: window, focused: focused, depth: depth + 1, into: &out) }
    }
}

func observe(_ id: Any?) {
    guard AXIsProcessTrusted() else { return fail(id, "accessibility_not_granted") }
    baseline = currentMouse()
    guard let app = frontApp(), let bundle = app.bundleIdentifier else { return fail(id, "no_front_app") }
    guard let win = focusedWindow(app), let frame = frameOf(win) else { return fail(id, "no_window") }
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    let focused = attr(appElement, kAXFocusedUIElementAttribute as String).map { $0 as! AXUIElement }
    var controls: [[String: Any]] = []
    collect(win, window: frame, focused: focused, depth: 0, into: &controls)
    let title = (attr(win, kAXTitleAttribute as String) as? String) ?? ""
    reply(["id": id as Any, "ok": true, "window": ["app": app.localizedName ?? "", "bundleId": bundle, "title": String(title.prefix(120)), "pid": Int(app.processIdentifier)], "controls": controls])
}

func guardFront(_ request: [String: Any], _ id: Any?) -> (NSRunningApplication, CGRect)? {
    guard AXIsProcessTrusted() else { fail(id, "accessibility_not_granted"); return nil }
    if userInterrupted() { fail(id, "user_interrupted"); return nil }
    guard let expected = request["bundleId"] as? String, let app = frontApp(), app.bundleIdentifier == expected else { fail(id, "front_app_changed"); return nil }
    guard let win = focusedWindow(app), let frame = frameOf(win) else { fail(id, "no_window"); return nil }
    return (app, frame)
}

func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

func click(_ request: [String: Any], _ id: Any?) {
    guard let (_, frame) = guardFront(request, id) else { return }
    guard let x = request["x"] as? Double, let y = request["y"] as? Double, x >= 0, x < 1, y >= 0, y < 1 else { return fail(id, "invalid_point") }
    let point = CGPoint(x: frame.minX + x * frame.width, y: frame.minY + y * frame.height)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
    usleep(60_000)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left))
    baseline = point
    reply(["id": id as Any, "ok": true])
}

func typeText(_ request: [String: Any], _ id: Any?) {
    guard guardFront(request, id) != nil else { return }
    guard let text = request["text"] as? String, !text.isEmpty, text.count <= 2000 else { return fail(id, "invalid_text") }
    for scalarChunk in text.unicodeScalars.map({ String($0) }) {
        let utf16 = Array(scalarChunk.utf16)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            post(event)
        }
        usleep(8_000)
    }
    reply(["id": id as Any, "ok": true])
}

let keyCodes: [String: CGKeyCode] = [
    "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117, "Enter": 36, "Return": 36, "Space": 49,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
]
func pressKey(_ request: [String: Any], _ id: Any?) {
    guard guardFront(request, id) != nil else { return }
    guard let key = request["key"] as? String, let code = keyCodes[key] else { return fail(id, "unsupported_key") }
    for down in [true, false] { post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)) }
    reply(["id": id as Any, "ok": true])
}

while let line = readLine() {
    guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { fail(nil, "bad_request"); continue }
    let id = request["id"]
    switch request["cmd"] as? String {
    case "ping": reply(["id": id as Any, "ok": true, "trusted": AXIsProcessTrusted()])
    case "observe": observe(id)
    case "click": click(request, id)
    case "type": typeText(request, id)
    case "key": pressKey(request, id)
    default: fail(id, "unknown_command")
    }
}
