import Foundation
import Darwin
#if NATIVE_AGENT_SOCKET_TESTING
import Security
#endif

enum NativeSocketFailure: Error, Equatable {
  case authentication
  case cursorConflict
  case invalid
  case busy
  case unavailable

  var code: String {
    switch self {
    case .authentication: return "mobile_socket_authentication"
    case .cursorConflict: return "mobile_socket_cursor_conflict"
    case .invalid: return "mobile_socket_invalid"
    case .busy: return "mobile_socket_busy"
    case .unavailable: return "mobile_socket_unavailable"
    }
  }
}

struct MobileSocketEvent {
  let type = "events"
  let text: String
}

final class NativeAgentSocket {
  private static let maximumTrackedSockets = 64
  private static let reservationTTL: TimeInterval = 60
  private static let maximumMessageBytes = 1_048_576
  private static let maximumSafeSequence = "9007199254740991"
  private static let jwtPattern = try! NSRegularExpression(
    pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$"
  )

  private enum State {
    case reserved
    case opening
    case open
    case closing
    case terminal
  }

  private final class Entry {
    var state: State = .reserved
    var touchedAt: Date
    var origin: String?
    var connection: AgentSocketConnection?
    var terminalFailure: NativeSocketFailure?
    var openCompletion: ((Result<Void, NativeSocketFailure>) -> Void)?
    var nextCompletion: ((Result<MobileSocketEvent, NativeSocketFailure>) -> Void)?
    var closeCompletions: [(Result<Void, NativeSocketFailure>) -> Void] = []

    init(touchedAt: Date) { self.touchedAt = touchedAt }
  }

  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var disposed = false
#if NATIVE_AGENT_SOCKET_TESTING
  private let fixtureCertificate: Data?
  init(fixtureCertificate: Data? = nil) { self.fixtureCertificate = fixtureCertificate }
#else
  init() {}
#endif

  func newSocketId() throws -> String {
    lock.lock(); defer { lock.unlock() }
    guard !disposed else { throw NativeSocketFailure.unavailable }
    let now = Date()
    pruneLocked(now: now, makeRoom: true)
    guard entries.count < Self.maximumTrackedSockets else {
      throw NativeSocketFailure.busy
    }
    var id: String
    repeat { id = UUID().uuidString.lowercased() } while entries[id] != nil
    entries[id] = Entry(touchedAt: now)
    return id
  }

  func openAgentSocket(socketId: String, origin: String, sessionId: String, afterSequence: String,
    accessToken: String, dpop: String,
    completion: @escaping (Result<Void, NativeSocketFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(socketId) else { throw NativeSocketFailure.invalid }
    let request = try Self.buildRequest(origin: origin, sessionId: sessionId, afterSequence: afterSequence,
      accessToken: accessToken, dpop: dpop)

    let connection: AgentSocketConnection
#if NATIVE_AGENT_SOCKET_TESTING
    connection = AgentSocketConnection(request: request, maximumMessageBytes: Self.maximumMessageBytes,
      fixtureCertificate: fixtureCertificate)
#else
    connection = AgentSocketConnection(request: request, maximumMessageBytes: Self.maximumMessageBytes)
#endif
    connection.onOpen = { [weak self, weak connection] in
      guard let self, let connection else { return }
      self.didOpen(socketId: socketId, connection: connection)
    }
    connection.onTerminal = { [weak self, weak connection] failure in
      guard let self, let connection else { return }
      self.didTerminate(socketId: socketId, connection: connection, failure: failure)
    }

    lock.lock()
    guard !disposed else {
      lock.unlock()
      throw NativeSocketFailure.unavailable
    }
    let now = Date()
    pruneLocked(now: now)
    guard let entry = entries[socketId], entry.state == .reserved else {
      lock.unlock()
      throw NativeSocketFailure.invalid
    }
    guard !entries.values.contains(where: { $0.origin == origin && $0.state != .reserved }) else {
      lock.unlock()
      throw NativeSocketFailure.busy
    }
    entry.state = .opening
    entry.origin = origin
    entry.connection = connection
    entry.openCompletion = completion
    entry.touchedAt = now
    lock.unlock()
    connection.start()
  }

  func nextAgentSocket(socketId: String,
    completion: @escaping (Result<MobileSocketEvent, NativeSocketFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(socketId) else { throw NativeSocketFailure.invalid }
    lock.lock()
    guard !disposed else {
      lock.unlock()
      throw NativeSocketFailure.unavailable
    }
    guard let entry = entries[socketId] else {
      lock.unlock()
      throw NativeSocketFailure.invalid
    }
    if entry.state == .terminal {
      let failure = entry.terminalFailure ?? .unavailable
      lock.unlock()
      completion(.failure(failure))
      return
    }
    guard entry.state == .open, let connection = entry.connection else {
      lock.unlock()
      throw NativeSocketFailure.unavailable
    }
    guard entry.nextCompletion == nil else {
      lock.unlock()
      throw NativeSocketFailure.busy
    }
    entry.nextCompletion = completion
    lock.unlock()

    connection.receive { [weak self, weak connection] result in
      guard let self, let connection else { return }
      self.didReceive(socketId: socketId, connection: connection, result: result)
    }
  }

  func closeAgentSocket(socketId: String,
    completion: @escaping (Result<Void, NativeSocketFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(socketId) else { throw NativeSocketFailure.invalid }
    lock.lock()
    guard !disposed else {
      lock.unlock()
      throw NativeSocketFailure.unavailable
    }
    let now = Date()
    pruneLocked(now: now)
    guard let entry = entries[socketId] else {
      lock.unlock()
      throw NativeSocketFailure.invalid
    }
    if entry.state == .reserved {
      entry.state = .terminal
      entry.touchedAt = now
      lock.unlock()
      completion(.success(()))
      return
    }
    if entry.state == .terminal {
      entry.origin = nil
      entry.touchedAt = now
      lock.unlock()
      completion(.success(()))
      return
    }
    entry.closeCompletions.append(completion)
    let connection = entry.connection
    if entry.state != .closing {
      entry.state = .closing
      let openCompletion = entry.openCompletion
      entry.openCompletion = nil
      let nextCompletion = entry.nextCompletion
      entry.nextCompletion = nil
      lock.unlock()
      openCompletion?(.failure(.unavailable))
      nextCompletion?(.failure(.unavailable))
      connection?.close()
      return
    }
    lock.unlock()
  }

  func closeAll() {
    lock.lock()
    if disposed { lock.unlock(); return }
    disposed = true
    let active = entries.values.compactMap { entry -> AgentSocketConnection? in
      guard entry.state != .reserved else { return nil }
      entry.state = .closing
      return entry.connection
    }
    let openCompletions = entries.values.compactMap { entry -> ((Result<Void, NativeSocketFailure>) -> Void)? in
      defer { entry.openCompletion = nil }
      return entry.openCompletion
    }
    let nextCompletions = entries.values.compactMap { entry -> ((Result<MobileSocketEvent, NativeSocketFailure>) -> Void)? in
      defer { entry.nextCompletion = nil }
      return entry.nextCompletion
    }
    entries = entries.filter { $0.value.state != .reserved }
    lock.unlock()
    openCompletions.forEach { $0(.failure(.unavailable)) }
    nextCompletions.forEach { $0(.failure(.unavailable)) }
    active.forEach { $0.close() }
  }

  private func didOpen(socketId: String, connection: AgentSocketConnection) {
    lock.lock()
    guard let entry = entries[socketId], entry.connection === connection else {
      lock.unlock()
      connection.close()
      return
    }
    guard entry.state == .opening else {
      lock.unlock()
      connection.close()
      return
    }
    entry.state = .open
    let completion = entry.openCompletion
    entry.openCompletion = nil
    lock.unlock()
    completion?(.success(()))
  }

  private func didReceive(socketId: String, connection: AgentSocketConnection,
    result: Result<MobileSocketEvent, NativeSocketFailure>) {
    lock.lock()
    guard let entry = entries[socketId], entry.connection === connection else {
      lock.unlock()
      return
    }
    let completion = entry.nextCompletion
    entry.nextCompletion = nil
    if case .failure(let failure) = result, failure == .invalid, entry.state != .closing {
      entry.state = .closing
    }
    lock.unlock()
    completion?(result)
    if case .failure(.invalid) = result { connection.failInvalid() }
  }

  private func didTerminate(socketId: String, connection: AgentSocketConnection, failure: NativeSocketFailure) {
    lock.lock()
    guard let entry = entries[socketId], entry.connection === connection else {
      lock.unlock()
      return
    }
    entry.state = .terminal
    entry.connection = nil
    entry.terminalFailure = failure
    entry.touchedAt = Date()
    let openCompletion = entry.openCompletion
    entry.openCompletion = nil
    let nextCompletion = entry.nextCompletion
    entry.nextCompletion = nil
    let closeCompletions = entry.closeCompletions
    entry.closeCompletions.removeAll()
    if !closeCompletions.isEmpty { entry.origin = nil }
    lock.unlock()
    openCompletion?(.failure(failure))
    nextCompletion?(.failure(failure))
    closeCompletions.forEach { $0(.success(())) }
  }

  private func pruneLocked(now: Date, makeRoom: Bool = false) {
    entries = entries.filter {
      let entry = $0.value
      if entry.state == .reserved { return now.timeIntervalSince(entry.touchedAt) < Self.reservationTTL }
      if entry.state == .terminal && entry.origin == nil {
        return now.timeIntervalSince(entry.touchedAt) < Self.reservationTTL
      }
      return true
    }
    if makeRoom, entries.count >= Self.maximumTrackedSockets,
      let oldest = entries.filter({ $0.value.state == .terminal && $0.value.origin == nil })
        .min(by: { $0.value.touchedAt < $1.value.touchedAt })?.key {
      entries.removeValue(forKey: oldest)
    }
  }

  private static func isCanonicalUUID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
  }

  private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
    let range = NSRange(value.startIndex..., in: value)
    return expression.firstMatch(in: value, range: range)?.range == range
  }

  private static func decimalAtMost(_ value: String, _ maximum: String) -> Bool {
    value.count < maximum.count || (value.count == maximum.count && value <= maximum)
  }

  private static func buildRequest(origin: String, sessionId: String, afterSequence: String,
    accessToken: String, dpop: String) throws -> URLRequest {
    guard let originComponents = URLComponents(string: origin), originComponents.scheme == "https",
      let host = originComponents.host, host == host.lowercased(), originComponents.port != 443,
      originComponents.user == nil, originComponents.password == nil, originComponents.path.isEmpty,
      originComponents.query == nil, originComponents.fragment == nil,
      originComponents.url?.absoluteString == origin,
      isCanonicalUUID(sessionId), sessionId[sessionId.index(sessionId.startIndex, offsetBy: 14)] != "0",
      matches(try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"), sessionId),
      matches(try! NSRegularExpression(pattern: "^(0|[1-9][0-9]*)$"), afterSequence),
      decimalAtMost(afterSequence, maximumSafeSequence),
      accessToken.utf8.count <= 8_192, matches(jwtPattern, accessToken),
      dpop.utf8.count <= 8_192, matches(jwtPattern, dpop) else { throw NativeSocketFailure.invalid }

    var components = originComponents
    components.scheme = "wss"
    components.path = "/api/agentflow/agent-sessions/\(sessionId)/events"
    components.percentEncodedQuery = "after_seq=\(afterSequence)"
    guard let url = components.url,
      url.absoluteString == origin.replacingOccurrences(of: "https://", with: "wss://", options: [.anchored]) +
        "/api/agentflow/agent-sessions/\(sessionId)/events?after_seq=\(afterSequence)" else {
      throw NativeSocketFailure.invalid
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = "GET"
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(dpop, forHTTPHeaderField: "DPoP")
    request.httpShouldHandleCookies = false
    return request
  }
}

private final class AgentSocketConnection: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
  var onOpen: (() -> Void)?
  var onTerminal: ((NativeSocketFailure) -> Void)?

  private let request: URLRequest
  private let maximumMessageBytes: Int
  private let stateLock = NSLock()
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var opened = false
  private var closing = false
  private var terminal = false
  private var forcedFailure: NativeSocketFailure?
#if NATIVE_AGENT_SOCKET_TESTING
  private let fixtureCertificate: Data?
  init(request: URLRequest, maximumMessageBytes: Int, fixtureCertificate: Data?) {
    self.request = request
    self.maximumMessageBytes = maximumMessageBytes
    self.fixtureCertificate = fixtureCertificate
  }
#else
  init(request: URLRequest, maximumMessageBytes: Int) {
    self.request = request
    self.maximumMessageBytes = maximumMessageBytes
  }
#endif

  func start() {
    stateLock.lock()
    guard !closing else { stateLock.unlock(); finish(.unavailable); return }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 10
    configuration.timeoutIntervalForResource = 0
    configuration.waitsForConnectivity = false
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .userInitiated
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    self.session = session
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = maximumMessageBytes
    self.task = task
    stateLock.unlock()
    task.resume()
  }

  func receive(completion: @escaping (Result<MobileSocketEvent, NativeSocketFailure>) -> Void) {
    stateLock.lock()
    guard opened, !closing, !terminal, let task else {
      stateLock.unlock()
      completion(.failure(.unavailable))
      return
    }
    stateLock.unlock()
    task.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        guard text.utf8.count <= self.maximumMessageBytes else {
          completion(.failure(.invalid))
          return
        }
        completion(.success(MobileSocketEvent(text: text)))
      case .success(.data):
        completion(.failure(.invalid))
      case .failure(let error):
        // A peer close also completes receive with an error. Let the close delegate
        // classify its status code instead of racing it with a generic receive error.
        let closeCode = task.closeCode.rawValue
        if closeCode != URLSessionWebSocketTask.CloseCode.invalid.rawValue { return }
        let failure = self.networkOrInvalid(error)
        if failure == .invalid { completion(.failure(.invalid)) }
      @unknown default:
        completion(.failure(.invalid))
      }
    }
  }

  func close() {
    stateLock.lock()
    if closing || terminal { stateLock.unlock(); return }
    closing = true
    let task = self.task
    stateLock.unlock()
    task?.cancel(with: .normalClosure, reason: nil)
    if task == nil { finish(.unavailable) }
  }

  func failInvalid() {
    stateLock.lock()
    if terminal { stateLock.unlock(); return }
    forcedFailure = .invalid
    closing = true
    let task = self.task
    stateLock.unlock()
    task?.cancel(with: .unsupportedData, reason: nil)
    if task == nil { finish(.invalid) }
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?) {
    stateLock.lock()
    let shouldDiscard = closing || terminal
    let response = webSocketTask.response as? HTTPURLResponse
    let valid = !shouldDiscard && `protocol` == nil && response?.statusCode == 101 &&
      response?.url == request.url && webSocketTask.currentRequest?.url == request.url &&
      response?.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == nil &&
      response?.value(forHTTPHeaderField: "Sec-WebSocket-Extensions") == nil
    if valid { opened = true }
    if !valid && forcedFailure == nil { forcedFailure = .invalid }
    stateLock.unlock()
    guard valid else {
      webSocketTask.cancel(with: .protocolError, reason: nil)
      return
    }
    onOpen?()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish(failure(forCloseCode: closeCode.rawValue))
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    stateLock.lock()
    let opened = self.opened
    let forcedFailure = self.forcedFailure
    let locallyClosing = self.closing && forcedFailure == nil
    stateLock.unlock()
    if let forcedFailure { finish(forcedFailure); return }
    if locallyClosing { finish(.unavailable); return }
    if let webSocketTask = task as? URLSessionWebSocketTask,
      webSocketTask.closeCode != .invalid {
      finish(failure(forCloseCode: webSocketTask.closeCode.rawValue))
      return
    }
    if let response = task.response as? HTTPURLResponse {
      switch response.statusCode {
      case 401, 403: finish(.authentication)
      case 409: finish(.cursorConflict)
      case 408, 429, 500...599: finish(.unavailable)
      case 101 where opened: finish(.unavailable)
      default: finish(.invalid)
      }
      return
    }
    if let error { finish(networkOrInvalid(error)); return }
    finish(.unavailable)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    stateLock.lock()
    forcedFailure = .invalid
    stateLock.unlock()
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
#if NATIVE_AGENT_SOCKET_TESTING
      if let fixtureCertificate,
        let certificate = SecCertificateCreateWithData(nil, fixtureCertificate as CFData),
        let trust = challenge.protectionSpace.serverTrust {
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var error: CFError?
        if SecTrustEvaluateWithError(trust, &error) {
          completionHandler(.useCredential, URLCredential(trust: trust))
          return
        }
      }
#endif
      completionHandler(.performDefaultHandling, nil)
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  private func networkOrInvalid(_ error: Error) -> NativeSocketFailure {
    let nativeError = error as NSError
    let code = nativeError.code
    switch code {
    case NSURLErrorCancelled, NSURLErrorTimedOut, NSURLErrorCannotFindHost,
      NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed,
      NSURLErrorNotConnectedToInternet, NSURLErrorSecureConnectionFailed,
      NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
      NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid,
      NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired:
      return .unavailable
    default:
      if nativeError.domain == NSURLErrorDomain {
        switch code {
        case NSURLErrorBadServerResponse, NSURLErrorCannotDecodeRawData,
          NSURLErrorCannotDecodeContentData, NSURLErrorDataLengthExceedsMaximum:
          return .invalid
        default:
          return .unavailable
        }
      }
      if nativeError.domain == NSPOSIXErrorDomain && (code == Int(EMSGSIZE) || code == Int(EPROTO)) {
        return .invalid
      }
      return .unavailable
    }
  }

  private func failure(forCloseCode code: Int) -> NativeSocketFailure {
    stateLock.lock()
    let forcedFailure = self.forcedFailure
    let locallyClosing = closing && forcedFailure == nil
    stateLock.unlock()
    if let forcedFailure { return forcedFailure }
    if locallyClosing { return .unavailable }
    switch code {
    case 1008, 4401, 4403: return .authentication
    case 4409: return .cursorConflict
    case 1002, 1003, 1007, 1009, 4400: return .invalid
    case 1011: return .unavailable
    default: return .unavailable
    }
  }

  private func finish(_ failure: NativeSocketFailure) {
    stateLock.lock()
    guard !terminal else { stateLock.unlock(); return }
    terminal = true
    stateLock.unlock()
    session?.finishTasksAndInvalidate()
    onTerminal?(failure)
  }
}
