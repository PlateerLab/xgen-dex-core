// dex-ax — macOS 접근성(AX) 도우미. 말로 다른 앱을 조작하는 빠른 조작(fast-act-computer.ts)과 에이전트의 데스크탑 앱
// 도구(desktop-tools.ts)가 쓴다.
// stdin 으로 JSON 한 줄씩 명령을 받아 stdout 에 JSON 한 줄로 답한다. 띄워 둔 채로 쓰므로 명령마다 기동 비용이
// 없고, 스냅샷의 요소 핸들을 ref 로 들고 있는다(다음 스냅샷까지).
//
// 명령 (모두 "id" 를 그대로 돌려준다):
//   {"cmd":"trusted","prompt":false}      접근성 권한 여부 (prompt 면 시스템 권한 창을 띄운다)
//   {"cmd":"front"}                       맨 앞 앱 {app,bundleId,pid,presenting}
//   {"cmd":"snapshot","pid":123}          그 앱의 초점 창 요소 + 메뉴바 항목 → refs (frame 포함), 창 크기
//   {"cmd":"press","ref":"e3"}            누르기 (AXPress, 안 되면 좌표 클릭)
//   {"cmd":"keys","combo":"escape"}       키 보내기 (맨 앞 앱으로 간다)
//   {"cmd":"hide","pid":123}              앱 숨기기
//   {"cmd":"minimize","pid":123}          그 앱의 초점 창 최소화
//   {"cmd":"activate","pid":123}          앱을 앞으로
//   {"cmd":"apps"}                        실행 중인 일반 앱 [{app,bundleId,pid,path,front,hidden}]
//   {"cmd":"focus","ref":"e3"}            요소에 초점 (입력 전에)
//   {"cmd":"setvalue","ref":"e3","text":"…"}  입력칸 값 바꾸기 (AXValue, 다시 읽어 확인)
//   {"cmd":"type","text":"…"}             글자 입력 (맨 앞 앱의 초점 요소로 간다)
//
// 접근성 권한은 이 도우미를 띄운 앱(설치본은 XGen Dex, 개발 실행은 터미널)이 받는다.
// 원본: mac-fastact 프로토타입의 fastact-ax (10/3 실측으로 다듬은 요소 이름·역할 규칙).
import AppKit
import ApplicationServices
import Foundation

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

// MARK: - AX 읽기

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = attr(el, name) else { return nil }
  if let s = v as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
  return nil
}

func bool(_ el: AXUIElement, _ name: String) -> Bool? { attr(el, name) as? Bool }

func children(_ el: AXUIElement) -> [AXUIElement] {
  (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { return nil }
  var pt = CGPoint.zero
  var sz = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &pt)
  AXValueGetValue(s as! AXValue, .cgSize, &sz)
  return CGRect(origin: pt, size: sz)
}

/// 첫 번째 글자 자식 — 행(AXRow)·셀처럼 제목이 자식 텍스트에 있는 요소의 이름.
func firstText(_ el: AXUIElement, depth: Int = 0) -> String? {
  if depth > 4 { return nil }
  for c in children(el) {
    let r = str(c, kAXRoleAttribute) ?? ""
    if r == "AXStaticText" || r == "AXTextField", let v = str(c, kAXValueAttribute), !v.isEmpty { return v }
    if let t = firstText(c, depth: depth + 1) { return t }
  }
  return nil
}

/// AX 역할 → 학습 데이터(웹 접근성 스냅샷)와 같은 표기. 모델이 본 적 있는 이름으로 맞춘다.
func webRole(_ role: String, _ subrole: String?) -> String? {
  switch role {
  case "AXButton", "AXMenuButton": return subrole == "AXTabButton" ? "tab" : "button"
  case "AXPopUpButton", "AXComboBox": return "combobox"
  case "AXCheckBox": return subrole == "AXSwitch" ? "switch" : "checkbox"
  case "AXRadioButton": return subrole == "AXTabButton" ? "tab" : "radio"
  case "AXTextField": return subrole == "AXSearchField" ? "searchbox" : "textbox"
  case "AXTextArea": return "textbox"
  case "AXLink": return "link"
  case "AXSlider": return "slider"
  case "AXDisclosureTriangle": return "button"
  case "AXRow", "AXCell": return "row"
  case "AXMenuItem", "AXMenuBarItem": return "menuitem"
  default: return nil
  }
}

func elementName(_ el: AXUIElement, role: String) -> String {
  for key in [kAXTitleAttribute, kAXDescriptionAttribute] {
    if let s = str(el, key), !s.isEmpty { return s }
  }
  if role == "AXTextField" || role == "AXTextArea" || role == "AXComboBox" {
    if let s = str(el, kAXPlaceholderValueAttribute), !s.isEmpty { return s }
  }
  if role == "AXRow" || role == "AXCell" || role == "AXButton" || role == "AXRadioButton" {
    if let s = firstText(el), !s.isEmpty { return s }
  }
  if let s = str(el, kAXHelpAttribute), !s.isEmpty { return s }
  if role == "AXTextArea" || role == "AXTextField" { return role == "AXTextArea" ? "본문" : "" }
  return str(el, kAXIdentifierAttribute) ?? ""
}

// MARK: - 스냅샷

var handles: [String: AXUIElement] = [:]

final class Collector {
  var refs: [[String: Any]] = []
  var n = 0
  let deadline: Double
  init(budgetMs: Double) { deadline = nowMs() + budgetMs }

  func add(_ el: AXUIElement, role: String, name: String, extra: [String: Any] = [:]) {
    n += 1
    let key = "e\(n)"
    var m: [String: Any] = ["ref": key, "role": role, "name": name]
    for (k, v) in extra { m[k] = v }
    refs.append(m)
    handles[key] = el
  }

  /// 목록(표·개요) 하나에서 담을 행의 수 — 파일 목록 같은 내용 행이 후보를 덮지 않게.
  let maxRowsPerList = 40
  var rowsSeen: [ObjectIdentifier: Int] = [:]
  var parentList: [AXUIElement] = []

  /// 창 안 요소를 깊이 우선으로 훑는다. 행(AXRow) 안쪽은 이미 이름을 땄으니 더 내려가지 않는다.
  func walk(_ el: AXUIElement, depth: Int) {
    if depth > 30 || nowMs() > deadline || n > 600 { return }
    let role = str(el, kAXRoleAttribute) ?? ""
    let sub = str(el, kAXSubroleAttribute)
    if role == "AXRow", let list = parentList.last {
      let key = ObjectIdentifier(list)
      let c = (rowsSeen[key] ?? 0) + 1
      rowsSeen[key] = c
      if c > maxRowsPerList { return }
    }
    let isList = role == "AXOutline" || role == "AXTable" || role == "AXList"
    if isList { parentList.append(el) }
    defer { if isList { parentList.removeLast() } }
    // 창 제어 버튼(닫기·최소화·확대·전체 화면)은 후보가 아니다 — "켜줘" 가 창 닫기를 누른 일이 있었다.
    let chrome: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
    if let s = sub, chrome.contains(s) { return }
    if let wr = webRole(role, sub), role != "AXMenuItem", role != "AXMenuBarItem" {
      let enabled = bool(el, kAXEnabledAttribute) ?? true
      let name = elementName(el, role: role)
      if enabled && (!name.isEmpty || wr == "textbox" || wr == "searchbox") {
        if let f = frame(el), f.width > 1, f.height > 1 {
          var extra: [String: Any] = ["frame": [f.minX, f.minY, f.width, f.height]]
          // 입력칸은 지금 값도 — 에이전트가 무엇이 적혀 있는지 보고 고친다.
          if wr == "textbox" || wr == "searchbox" || wr == "combobox", let v = str(el, kAXValueAttribute), !v.isEmpty {
            extra["value"] = String(v.prefix(200))
          }
          add(el, role: wr, name: name, extra: extra)
        }
      }
      if role == "AXRow" || role == "AXButton" { return }
    }
    for c in children(el) { walk(c, depth: depth + 1) }
  }

  /// 메뉴바 — "파일 > 새로운 메모" 처럼 경로를 이름으로 쓴다. 최근 항목·서비스처럼 내용이 끝없는 하위 메뉴는 뺀다.
  func menus(_ app: AXUIElement) {
    guard let bar = attr(app, kAXMenuBarAttribute) else { return }
    let barEl = bar as! AXUIElement
    for top in children(barEl).dropFirst() {  // 첫 항목은 Apple 메뉴
      let topName = str(top, kAXTitleAttribute) ?? ""
      if topName.isEmpty { continue }
      for menu in children(top) { menuItems(menu, path: [topName], depth: 0) }
    }
  }

  func menuItems(_ menu: AXUIElement, path: [String], depth: Int) {
    if depth > 2 || nowMs() > deadline { return }
    for item in children(menu) {
      let title = str(item, kAXTitleAttribute) ?? ""
      if title.isEmpty { continue }  // 구분선
      let sub = children(item)
      if !sub.isEmpty {
        let skip = title.range(of: "^(최근|서비스|Open Recent|Recent|Services)", options: .regularExpression) != nil
        if !skip { for m in sub { menuItems(m, path: path + [title], depth: depth + 1) } }
        continue
      }
      guard bool(item, kAXEnabledAttribute) ?? true else { continue }
      add(item, role: "menuitem", name: (path + [title]).joined(separator: " > "))
    }
  }
}

/// 맨 앞(초점) 앱. 런루프 없이 도는 이 도우미에서는 NSWorkspace.frontmostApplication 이 처음 값에 멈춘다(앱을 바꿔도
/// 그대로 — 10/16 실측) — 접근성의 초점 앱을 본다.
func frontApp() -> NSRunningApplication? {
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &v) == .success,
    let el = v, CFGetTypeID(el) == AXUIElementGetTypeID()
  {
    var pid: pid_t = 0
    if AXUIElementGetPid(el as! AXUIElement, &pid) == .success, let a = NSRunningApplication(processIdentifier: pid) { return a }
  }
  return NSWorkspace.shared.frontmostApplication
}

func app(_ pid: pid_t?) -> NSRunningApplication? {
  guard let pid = pid, pid > 0 else { return frontApp() }
  return NSRunningApplication(processIdentifier: pid)
}

/// 앱의 창 중 화면 하나를 통째로 덮는 것이 있는가 — 발표(슬라이드 쇼)·전체 화면. 발표자 보기를 쓰면 초점 창은
/// 노트북 화면의 발표자 보기이고 슬라이드는 다른 화면을 덮으므로 초점 창만이 아니라 모든 창을 본다.
func presenting(_ axApp: AXUIElement) -> Bool {
  let sizes = NSScreen.screens.map { $0.frame.size }
  for w in (attr(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
    // 창만 본다 — Finder 는 창 목록에 화면 크기의 바탕화면(AXScrollArea/AXDesktop)을 넣는다(10/16 실측).
    guard str(w, kAXRoleAttribute) == "AXWindow", bool(w, kAXMinimizedAttribute) != true else { continue }
    if bool(w, "AXFullScreen") == true { return true }
    guard let f = frame(w) else { continue }
    if sizes.contains(where: { abs($0.width - f.width) < 2 && abs($0.height - f.height) < 2 }) { return true }
  }
  return false
}

func front() -> [String: Any] {
  guard let a = frontApp() else { return ["ok": false, "error": "앞 앱 없음"] }
  let axApp = AXUIElementCreateApplication(a.processIdentifier)
  return [
    "ok": true, "app": a.localizedName ?? "", "bundleId": a.bundleIdentifier ?? "", "pid": a.processIdentifier,
    "presenting": presenting(axApp),
  ]
}

func snapshot(_ req: [String: Any]) -> [String: Any] {
  let t0 = nowMs()
  guard let a = app((req["pid"] as? NSNumber)?.int32Value) else { return ["ok": false, "error": "앱을 찾지 못함"] }
  let axApp = AXUIElementCreateApplication(a.processIdentifier)
  handles.removeAll()
  let col = Collector(budgetMs: (req["budgetMs"] as? Double) ?? 1500)
  var res: [String: Any] = [
    "ok": true, "app": a.localizedName ?? "", "bundleId": a.bundleIdentifier ?? "", "pid": a.processIdentifier,
  ]
  if let w = attr(axApp, kAXFocusedWindowAttribute) ?? attr(axApp, kAXMainWindowAttribute) {
    let win = w as! AXUIElement
    res["window"] = str(win, kAXTitleAttribute) ?? ""
    if let f = frame(win) { res["windowFrame"] = [f.minX, f.minY, f.width, f.height] }
    col.walk(win, depth: 0)
  }
  res["windowCount"] = col.n
  if (req["menus"] as? Bool) ?? true { col.menus(axApp) }
  res["refs"] = col.refs
  res["presenting"] = presenting(axApp)
  res["ms"] = nowMs() - t0
  return res
}

// MARK: - 실행

func clickCenter(_ el: AXUIElement) -> Bool {
  guard let f = frame(el) else { return false }
  let p = CGPoint(x: f.midX, y: f.midY)
  let src = CGEventSource(stateID: .hidSystemState)
  for type in [CGEventType.leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  }
  return true
}

func press(_ ref: String) -> [String: Any] {
  let t0 = nowMs()
  guard let el = handles[ref] else { return ["ok": false, "error": "ref 없음: \(ref)"] }
  let role = str(el, kAXRoleAttribute) ?? ""
  var how = "AXPress"
  var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
  if err != .success, role == "AXRow" || role == "AXCell" {
    err = AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    how = "select"
  }
  if err != .success {
    how = "click"
    if !clickCenter(el) { return ["ok": false, "error": "누르기 실패 (\(err.rawValue))", "ms": nowMs() - t0] }
  }
  return ["ok": true, "how": how, "ms": nowMs() - t0]
}

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
  "7": 26, "-": 27, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45,
  "m": 46, ",": 43, ".": 47, "/": 44, "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
  "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126, "pageup": 116, "pagedown": 121,
]

func keys(_ combo: String, pid: pid_t? = nil) -> [String: Any] {
  let parts = combo.lowercased().split(separator: "+").map(String.init)
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for p in parts {
    switch p {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: key = keyCodes[p]
    }
  }
  guard let k = key else { return ["ok": false, "error": "모르는 키: \(combo)"] }
  let src = CGEventSource(stateID: .hidSystemState)
  guard let down = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true),
    let up = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false)
  else { return ["ok": false, "error": "키 이벤트를 만들지 못함"] }
  for event in [down, up] {
    event.flags = flags
    if let target = pid { event.postToPid(target) }
    else { event.post(tap: .cghidEventTap) }
  }
  return ["ok": true]
}

func visibleAppWindows(_ pid: pid_t) -> Int? {
  guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  return windows.filter { window in
    guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
      let bounds = window[kCGWindowBounds as String] as? [String: Any]
    else { return false }
    let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
    let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
    let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
    return width > 100 && height > 80 && alpha > 0
  }.count
}

func hide(_ pid: pid_t?) -> [String: Any] {
  guard let a = app(pid) else { return ["ok": false, "error": "앱을 찾지 못함"] }
  // hide()는 실제로 숨기고도 false를 반환할 수 있어, 런루프를 돌린 뒤 창 상태로 확인한다.
  let axApp = AXUIElementCreateApplication(a.processIdentifier)
  _ = a.hide()
  var gone = 0
  var visible: Int?
  var hidden = false
  for _ in 0..<30 {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    hidden = (attr(axApp, kAXHiddenAttribute) as? Bool) == true || NSRunningApplication(processIdentifier: a.processIdentifier)?.isHidden == true
    visible = visibleAppWindows(a.processIdentifier)
    gone = hidden && visible == 0 ? gone + 1 : 0
    if gone >= 5 {
      return ["ok": true, "hidden": true, "visibleWindows": 0]
    }
  }
  return ["ok": false, "hidden": hidden, "visibleWindows": visible ?? -1, "error": "앱 창이 화면에서 사라졌는지 확인하지 못해 숨기기를 완료하지 않았습니다."]
}

func minimize(_ pid: pid_t?) -> [String: Any] {
  guard let a = app(pid) else { return ["ok": false, "error": "앱을 찾지 못함"] }
  let axApp = AXUIElementCreateApplication(a.processIdentifier)
  guard let w = attr(axApp, kAXFocusedWindowAttribute) ?? attr(axApp, kAXMainWindowAttribute) else {
    return ["ok": false, "error": "창 없음"]
  }
  let err = AXUIElementSetAttributeValue(w as! AXUIElement, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
  return err == .success ? ["ok": true] : ["ok": false, "error": "최소화 실패 (\(err.rawValue))"]
}

func activate(_ pid: pid_t?) -> [String: Any] {
  guard let a = app(pid) else { return ["ok": false, "error": "앱을 찾지 못함"] }
  return ["ok": a.activate()]
}

/// Only slide-number markers are compared; presenter clocks must not count as a slide change.
func slideMarker(_ window: AXUIElement) -> String? {
  var markers = Set<String>()
  let deadline = nowMs() + 200
  var visited = 0
  func walk(_ el: AXUIElement, _ depth: Int) {
    visited += 1
    if depth > 18 || visited > 800 || nowMs() > deadline { return }
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
      if let value = str(el, key), value.count < 160,
        value.range(of: #"(?i)(?:slide|슬라이드|장표)\s*\d+|\b\d+\s*(?:/|of)\s*\d+\b"#, options: .regularExpression) != nil {
        markers.insert(value)
      }
    }
    for child in children(el) { walk(child, depth + 1) }
  }
  walk(window, 0)
  return markers.isEmpty ? nil : markers.sorted().joined(separator: " | ")
}

func powerPointShowWindows(_ axApp: AXUIElement) -> [AXUIElement] {
  // A maximized editor is not a slide show. Match PowerPoint's show-window titles.
  return ((attr(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? []).filter { window in
    let title = (str(window, kAXTitleAttribute) ?? "").lowercased()
    return ["powerpoint slide show", "powerpoint presenter view", "powerpoint 슬라이드 쇼", "powerpoint 발표자 보기"].contains { title.hasPrefix($0) }
  }
}

func focusPowerPointShowWindow(_ axApp: AXUIElement, _ pid: pid_t) -> AXUIElement? {
  let windows = powerPointShowWindows(axApp)
  if frontApp()?.processIdentifier == pid, let focused = attr(axApp, kAXFocusedWindowAttribute),
    let window = windows.first(where: { CFEqual($0, focused) }) { return window }
  guard let window = windows.first else { return nil }
  _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  _ = AXUIElementSetAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, window)
  let deadline = nowMs() + 1000
  repeat {
    if frontApp()?.processIdentifier == pid, let focused = attr(axApp, kAXFocusedWindowAttribute),
      CFEqual(window, focused) { return window }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
  } while nowMs() < deadline
  return nil
}

func presentation(_ pid: pid_t?, _ operation: String) -> [String: Any] {
  guard ["next", "previous", "hide", "show"].contains(operation), let pid = pid, pid > 0,
    let target = NSRunningApplication(processIdentifier: pid),
    target.bundleIdentifier?.lowercased() == "com.microsoft.powerpoint"
  else { return ["ok": false, "error": "발표 조작 대상 PowerPoint를 찾지 못함"] }
  guard AXIsProcessTrusted() else { return ["ok": false, "error": "접근성 권한이 필요합니다"] }
  let axApp = AXUIElementCreateApplication(pid)
  func result(_ verified: Bool, _ reason: String = "") -> [String: Any] {
    return ["ok": true, "pid": pid, "action": operation, "verified": verified, "reason": reason]
  }
  let hidden = (attr(axApp, kAXHiddenAttribute) as? Bool) ?? target.isHidden
  if (operation == "next" || operation == "previous") && (hidden || powerPointShowWindows(axApp).isEmpty) {
    return result(false, "발표 화면이 보이지 않아 슬라이드 키를 보내지 않았습니다.")
  }
  _ = target.activate()
  let focusDeadline = nowMs() + 1500
  while frontApp()?.processIdentifier != pid && nowMs() < focusDeadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
  }
  guard frontApp()?.processIdentifier == pid,
    ((attr(axApp, kAXHiddenAttribute) as? Bool) ?? target.isHidden) == false
  else { return result(false, "PowerPoint가 입력 대상인지 확인하지 못해 중단했습니다.") }
  if operation == "hide" {
    if !powerPointShowWindows(axApp).isEmpty {
      guard focusPowerPointShowWindow(axApp, pid) != nil else {
        return result(false, "발표 창의 초점을 확인하지 못해 쇼 종료 키를 보내지 않았습니다.")
      }
      let sent = keys("escape", pid: pid)
      guard sent["ok"] as? Bool == true else { return result(false, "쇼 종료 키를 보내지 못했습니다.") }
      let deadline = nowMs() + 2000
      while !powerPointShowWindows(axApp).isEmpty && nowMs() < deadline {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
      }
      guard powerPointShowWindows(axApp).isEmpty else { return result(false, "슬라이드 쇼가 종료되지 않아 XGEN으로 전환하지 않았습니다.") }
    }
    let hideStarted = nowMs()
    var lastCount: Int?
    // The editor can reappear while the show exits. Retry only the idempotent hide, never Escape.
    for attempt in 1...3 {
      guard powerPointShowWindows(axApp).isEmpty else { return result(false, "슬라이드 쇼가 다시 열려 숨김을 중단했습니다.") }
      let reply = hide(pid)
      lastCount = reply["visibleWindows"] as? Int
      if reply["ok"] as? Bool == true {
        var out = result(true)
        out["visibleWindows"] = 0
        out["hideAttempts"] = attempt
        out["settleMs"] = Int(nowMs() - hideStarted)
        return out
      }
    }
    var out = result(false, "쇼는 종료됐지만 PowerPoint 창 숨김을 확인하지 못했습니다. XGEN으로 전환하지 않았어요.")
    if let count = lastCount, count >= 0 { out["visibleWindows"] = count }
    out["hideAttempts"] = 3
    out["settleMs"] = Int(nowMs() - hideStarted)
    return out
  }
  if operation == "show" {
    if !powerPointShowWindows(axApp).isEmpty {
      guard focusPowerPointShowWindow(axApp, pid) != nil else {
        return result(false, "발표 창의 초점을 확인하지 못했습니다.")
      }
      return result(true)
    }
    let sent = keys("cmd+return", pid: pid)
    guard sent["ok"] as? Bool == true else { return result(false, "현재 슬라이드부터 시작 키를 보내지 못했습니다.") }
    let deadline = nowMs() + 3000
    while powerPointShowWindows(axApp).isEmpty && nowMs() < deadline {
      RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    guard !powerPointShowWindows(axApp).isEmpty else { return result(false, "현재 슬라이드부터 쇼가 시작됐는지 확인하지 못했습니다. 자동으로 재시작하지 않습니다.") }
    return result(true)
  }
  guard let showWindow = focusPowerPointShowWindow(axApp, pid) else {
    return result(false, "발표 창의 초점을 확인하지 못해 슬라이드 키를 보내지 않았습니다.")
  }
  let before = slideMarker(showWindow)
  guard frontApp()?.processIdentifier == pid, let focused = attr(axApp, kAXFocusedWindowAttribute), CFEqual(showWindow, focused) else {
    return result(false, "입력 대상 창이 바뀌어 슬라이드 키를 보내지 않았습니다.")
  }
  let sent = keys(operation == "next" ? "right" : "left", pid: pid)
  guard sent["ok"] as? Bool == true else { return result(false, sent["error"] as? String ?? "키 전송 실패") }
  let deadline = nowMs() + 1200
  while nowMs() < deadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
    if let before = before, let after = slideMarker(showWindow), before != after { return result(true) }
  }
  return result(false, "PowerPoint에 슬라이드 키를 한 번 보냈지만 장 변경은 확인하지 못했습니다. 자동으로 재전송하지 않습니다.")
}

func runningApps() -> [String: Any] {
  // 런루프 없이 도는 이 도우미에서 NSWorkspace 목록은 실행·종료 알림을 받지 못해 낡는다 — 잠깐 돌려 갱신한다.
  RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
  let frontPid = frontApp()?.processIdentifier
  let list: [[String: Any]] = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { a in
    let axApp = AXUIElementCreateApplication(a.processIdentifier)
    return [
      "app": a.localizedName ?? "", "bundleId": a.bundleIdentifier ?? "", "pid": a.processIdentifier,
      "path": a.bundleURL?.path ?? "", "front": a.processIdentifier == frontPid,
      "hidden": (attr(axApp, kAXHiddenAttribute) as? Bool) ?? a.isHidden,
      "presenting": a.bundleIdentifier?.lowercased() == "com.microsoft.powerpoint" && !powerPointShowWindows(axApp).isEmpty,
    ]
  }
  return ["ok": true, "apps": list]
}

func focus(_ ref: String) -> [String: Any] {
  guard let el = handles[ref] else { return ["ok": false, "error": "ref 없음: \(ref)"] }
  let err = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  return err == .success ? ["ok": true] : ["ok": false, "error": "초점 실패 (\(err.rawValue))"]
}

func setValue(_ ref: String, _ text: String) -> [String: Any] {
  guard let el = handles[ref] else { return ["ok": false, "error": "ref 없음: \(ref)"] }
  let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString)
  if err != .success { return ["ok": false, "error": "값 바꾸기 실패 (\(err.rawValue)) — 초점을 주고 type 으로 입력"] }
  return (str(el, kAXValueAttribute) ?? "") == text ? ["ok": true] : ["ok": false, "error": "값이 바뀌지 않음 — 초점을 주고 type 으로 입력"]
}

/// 글자를 유니코드 키 이벤트로 보낸다(자판 배치와 무관). 줄바꿈은 return 키로.
func typeText(_ text: String) -> [String: Any] {
  let src = CGEventSource(stateID: .hidSystemState)
  let lines = text.components(separatedBy: "\n")
  for (i, line) in lines.enumerated() {
    if i > 0 { _ = keys("return"); usleep(10_000) }
    var rest = Substring(line)
    while !rest.isEmpty {
      let chunk = Array(String(rest.prefix(16)).utf16)
      rest = rest.dropFirst(16)
      for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
        chunk.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: $0.baseAddress) }
        e?.post(tap: .cghidEventTap)
      }
      usleep(10_000)
    }
  }
  return ["ok": true]
}

// MARK: - 루프

while let line = readLine() {
  guard let data = line.data(using: .utf8),
    let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  else {
    emit(["ok": false, "error": "JSON 아님"])
    continue
  }
  let id = req["id"] ?? NSNull()
  let pid = (req["pid"] as? NSNumber)?.int32Value
  var res: [String: Any]
  switch req["cmd"] as? String ?? "" {
  case "trusted":
    let prompt = (req["prompt"] as? Bool) ?? false
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    res = ["ok": true, "trusted": AXIsProcessTrustedWithOptions(opts)]
  case "front": res = front()
  case "snapshot": res = snapshot(req)
  case "press": res = press((req["ref"] as? String) ?? "")
  case "keys": res = keys((req["combo"] as? String) ?? "")
  case "hide": res = hide(pid)
  case "minimize": res = minimize(pid)
  case "activate": res = activate(pid)
  case "presentation": res = presentation(pid, (req["action"] as? String) ?? "")
  case "apps": res = runningApps()
  case "focus": res = focus((req["ref"] as? String) ?? "")
  case "setvalue": res = setValue((req["ref"] as? String) ?? "", (req["text"] as? String) ?? "")
  case "type": res = typeText((req["text"] as? String) ?? "")
  default: res = ["ok": false, "error": "모르는 명령"]
  }
  res["id"] = id
  emit(res)
}
