import ExpoModulesCore
import UIKit
import UniformTypeIdentifiers

internal final class FolderAccessException: GenericException<String> {
  override var reason: String {
    param
  }
}

private final class FolderPickingDelegate: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private let onPick: ([URL]) -> Void
  private let onCancel: () -> Void

  init(onPick: @escaping ([URL]) -> Void, onCancel: @escaping () -> Void) {
    self.onPick = onPick
    self.onCancel = onCancel
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    onPick(urls)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    onCancel()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    onCancel()
  }
}

/**
 Folders the user connects to a conversation, on iOS.

 The user picks folders with the system picker; each one is kept as a bookmark
 so access survives restarts. Resolving a bookmark starts security-scoped
 access for this process, after which the app reads and writes inside that
 folder with ordinary file URLs. Disconnecting stops the access.
 */
public final class XgenFolderAccessModule: Module {
  private var pendingPromise: Promise?
  private var pendingDelegate: FolderPickingDelegate?
  /// Folders whose security-scoped access is started, by standardized path.
  private var accessing: [String: URL] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("XgenFolderAccess")

    AsyncFunction("pickFolders") { (promise: Promise) in
      if self.pendingPromise != nil {
        throw FolderAccessException("이미 폴더를 고르는 중입니다.")
      }
      guard let current = self.appContext?.utilities?.currentViewController() else {
        throw FolderAccessException("화면을 찾지 못했습니다.")
      }
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
      picker.allowsMultipleSelection = true
      let delegate = FolderPickingDelegate(
        onPick: { [weak self] urls in self?.finishPick(urls) },
        onCancel: { [weak self] in self?.cancelPick() }
      )
      picker.delegate = delegate
      picker.presentationController?.delegate = delegate
      self.pendingPromise = promise
      self.pendingDelegate = delegate
      current.present(picker, animated: true)
    }.runOnQueue(.main)

    /// Starts access to a saved folder. Returns a fresh bookmark when iOS says
    /// the saved one is stale (the folder moved), so the caller can store it.
    AsyncFunction("resolveBookmark") { (bookmark: String) -> [String: Any] in
      guard let data = Data(base64Encoded: bookmark) else {
        throw FolderAccessException("저장된 폴더 정보가 손상되었습니다. 폴더를 다시 연결하세요.")
      }
      var stale = false
      let url: URL
      do {
        url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
      } catch {
        throw FolderAccessException("폴더를 찾지 못했습니다. 폴더를 다시 연결하세요.")
      }
      guard self.startAccess(url) else {
        throw FolderAccessException("폴더에 접근할 권한이 없습니다. 폴더를 다시 연결하세요.")
      }
      var fresh = bookmark
      if stale, let renewed = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        fresh = renewed.base64EncodedString()
      }
      return [
        "uri": url.absoluteString,
        "name": url.lastPathComponent,
        "bookmark": fresh,
        "stale": stale,
      ]
    }

    /// Stops access when the user disconnects the folder.
    Function("release") { (uri: String) in
      guard let url = URL(string: uri) else {
        return
      }
      let key = url.standardizedFileURL.path
      self.lock.lock()
      let started = self.accessing.removeValue(forKey: key)
      self.lock.unlock()
      started?.stopAccessingSecurityScopedResource()
    }
  }

  private func startAccess(_ url: URL) -> Bool {
    let key = url.standardizedFileURL.path
    lock.lock()
    defer { lock.unlock() }
    if accessing[key] != nil {
      return true
    }
    if url.startAccessingSecurityScopedResource() {
      accessing[key] = url
      return true
    }
    // Folders inside the app's own container need no security scope.
    return FileManager.default.isReadableFile(atPath: url.path)
  }

  private func finishPick(_ urls: [URL]) {
    guard let promise = pendingPromise else {
      return
    }
    pendingPromise = nil
    pendingDelegate = nil
    var picked: [[String: Any]] = []
    for url in urls {
      let started = url.startAccessingSecurityScopedResource()
      defer {
        if started {
          url.stopAccessingSecurityScopedResource()
        }
      }
      guard let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
        continue
      }
      picked.append([
        "uri": url.absoluteString,
        "name": url.lastPathComponent,
        "bookmark": data.base64EncodedString(),
      ])
    }
    promise.resolve(picked)
  }

  private func cancelPick() {
    guard let promise = pendingPromise else {
      return
    }
    pendingPromise = nil
    pendingDelegate = nil
    promise.resolve([[String: Any]]())
  }
}
