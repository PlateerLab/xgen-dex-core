import Foundation
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
import Security
#endif

enum MobileTransportFailure: Error {
  case invalid
  case unavailable
  case busy
  case responseInvalid

  var code: String {
    switch self {
    case .invalid: return "mobile_transport_invalid"
    case .unavailable: return "mobile_transport_unavailable"
    case .busy: return "mobile_transport_busy"
    case .responseInvalid: return "mobile_transport_response_invalid"
    }
  }
}

struct MobileTransportResponse {
  let status: Int
  let body: String
}

final class NativeEnrollmentTransport {
  private static let maximumRequestBodyBytes = 32_768
  private static let maximumTurnRequestBodyBytes = 2_097_152
  private static let maximumResponseBodyBytes = 65_536
  private static let maximumMessagesResponseBodyBytes = 1_048_576
  private static let maximumTrackedRequests = 1_024
  private static let reservationTTL: TimeInterval = 60
  private static let accessTokenPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9._~-]{1,8192}$")
  private static let dpopPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
  private static let statusPath = try! NSRegularExpression(pattern: "^/api/auth/platform-devices/native/mobile/registration/status/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  private static let approvalBeginPath = try! NSRegularExpression(pattern: "^/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests/begin$")
  private static let approvalPath = try! NSRegularExpression(pattern: "^/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests$")
  private static let sessionPath = try! NSRegularExpression(pattern: "^/api/me/platform-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private static let maximumSafeSequence = "9007199254740991"
  private static let canonicalUUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
  private static let agentEventsPath = try! NSRegularExpression(pattern: "^/api/agentflow/me/agent-events\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)$")
  private static let agentSessionsPath = try! NSRegularExpression(pattern: "^/api/agentflow/me/agent-sessions\\?limit=([1-9][0-9]*)(?:&before_id=(\(canonicalUUID)))?$")
  private static let sessionSnapshotPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/\(canonicalUUID)/snapshot$")
  private static let sessionEventsPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/\(canonicalUUID)/events\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)$")
  private static let sessionMessagesPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/\(canonicalUUID)/messages\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)$")
  private static let sessionTurnPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/\(canonicalUUID)/(turns|stop)$")
  private static let canonicalUUIDPattern = try! NSRegularExpression(pattern: "^\(canonicalUUID)$")
  private static let stableASCII = try! NSRegularExpression(pattern: "^[!-~]{1,128}$")
  private static let createAgentSessionPath = "/api/agentflow/agent-sessions"
  private static let switchAgentFocusPath = "/api/agentflow/me/agent-state"

  private let lock = NSLock()
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
  private let fixtureCertificate: Data?
  private let taskDidComplete: ((String) -> Void)?
  init(fixtureCertificate: Data? = nil, taskDidComplete: ((String) -> Void)? = nil) {
    self.fixtureCertificate = fixtureCertificate
    self.taskDidComplete = taskDidComplete
  }
#else
  init() {}
#endif
  private final class TrackedRequest {
    var touchedAt: Date
    var operation: NativeEnrollmentRequest?
    var cancelled = false
    init(touchedAt: Date, operation: NativeEnrollmentRequest? = nil) {
      self.touchedAt = touchedAt
      self.operation = operation
    }
  }
  private var tracked: [String: TrackedRequest] = [:]

  private func pruneLocked(now: Date) {
    tracked = tracked.filter { $0.value.operation != nil || now.timeIntervalSince($0.value.touchedAt) < Self.reservationTTL }
    while tracked.count >= Self.maximumTrackedRequests,
      let oldest = tracked.filter({ $0.value.operation == nil }).min(by: { $0.value.touchedAt < $1.value.touchedAt })?.key {
      tracked.removeValue(forKey: oldest)
    }
  }

  func newRequestId() throws -> String {
    lock.lock(); defer { lock.unlock() }
    let now = Date()
    pruneLocked(now: now)
    guard tracked.count < Self.maximumTrackedRequests else { throw MobileTransportFailure.busy }
    var id: String
    repeat { id = UUID().uuidString.lowercased() } while tracked[id] != nil
    tracked[id] = TrackedRequest(touchedAt: now)
    return id
  }

  static func isCanonicalUUID(_ value: String) -> Bool {
    UUID(uuidString: value)?.uuidString.lowercased() == value
  }

  private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
    let fullRange = NSRange(value.startIndex..., in: value)
    return expression.firstMatch(in: value, range: fullRange)?.range == fullRange
  }

  private static func allowed(_ method: String, _ path: String) -> Bool {
    switch method {
    case "GET":
      return path == "/api/auth/platform-devices/trust-overview" || matches(statusPath, path)
    case "POST":
      return path == "/api/auth/platform-devices/native/mobile/registration/challenge" ||
        path == "/api/auth/platform-devices/native/mobile/registration/complete" ||
        matches(approvalBeginPath, path) || matches(approvalPath, path)
    default:
      return false
    }
  }

  private static func buildRequest(origin: String, path: String, method: String, accessToken: String, body: String?) throws -> URLRequest {
    guard let components = URLComponents(string: origin), components.scheme == "https", components.host != nil,
      components.user == nil, components.password == nil, components.path.isEmpty, components.query == nil,
      components.fragment == nil, components.url?.absoluteString == origin,
      allowed(method, path), !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"),
      matches(accessTokenPattern, accessToken),
      let url = URL(string: origin + path), url.absoluteString == origin + path else { throw MobileTransportFailure.invalid }

    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
    switch method {
    case "GET":
      guard body == nil else { throw MobileTransportFailure.invalid }
    case "POST":
      guard let body, let data = body.data(using: .utf8), data.count <= maximumRequestBodyBytes,
        StrictJSONObject.isValid(body) else { throw MobileTransportFailure.invalid }
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      // A one-shot stream lets the delegate refuse a replacement body stream if Foundation asks
      // to replay an upload after a challenge or transport failure.
      request.httpBodyStream = InputStream(data: data)
    default:
      throw MobileTransportFailure.invalid
    }
    return request
  }

  private static func setJSONBody(_ body: String?, on request: inout URLRequest) throws {
    guard let body, let data = body.data(using: .utf8), data.count <= maximumRequestBodyBytes,
      StrictJSONObject.isValid(body) else { throw MobileTransportFailure.invalid }
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBodyStream = InputStream(data: data)
  }

  private static func buildSessionRequest(origin: String, path: String, method: String, authorization: String?, dpop: String?, body: String?) throws -> URLRequest {
    guard let components = URLComponents(string: origin), components.scheme == "https", components.host != nil,
      components.user == nil, components.password == nil, components.path.isEmpty, components.query == nil,
      components.fragment == nil, components.url?.absoluteString == origin,
      !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"),
      let url = URL(string: origin + path), url.absoluteString == origin + path else { throw MobileTransportFailure.invalid }

    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    switch (method, path) {
    case ("POST", "/api/auth/platform-sessions/native/login-key/begin"),
      ("POST", "/api/auth/platform-sessions/native/login-key/complete"):
      guard let authorization, authorization.hasPrefix("Bearer "),
        matches(accessTokenPattern, String(authorization.dropFirst(7))), dpop == nil else { throw MobileTransportFailure.invalid }
      request.setValue(authorization, forHTTPHeaderField: "Authorization")
      try setJSONBody(body, on: &request)
    case ("POST", "/api/auth/platform-sessions/native/refresh/begin"),
      ("POST", "/api/auth/platform-sessions/native/refresh/complete"):
      guard authorization == nil, dpop == nil else { throw MobileTransportFailure.invalid }
      try setJSONBody(body, on: &request)
    case ("DELETE", _):
      guard matches(sessionPath, path), let authorization, authorization.hasPrefix("DPoP "),
        authorization.dropFirst(5).utf8.count <= 8_192, matches(dpopPattern, String(authorization.dropFirst(5))), let dpop,
        dpop.utf8.count <= 8_192, matches(dpopPattern, dpop) else { throw MobileTransportFailure.invalid }
      request.setValue(authorization, forHTTPHeaderField: "Authorization")
      request.setValue(dpop, forHTTPHeaderField: "DPoP")
      try setJSONBody(body, on: &request)
    default:
      throw MobileTransportFailure.invalid
    }
    return request
  }

  private static func capture(_ match: NSTextCheckingResult, _ index: Int, in value: String) -> String? {
    let range = match.range(at: index)
    guard range.location != NSNotFound, let swiftRange = Range(range, in: value) else { return nil }
    return String(value[swiftRange])
  }

  private static func decimalAtMost(_ value: String, _ maximum: String) -> Bool {
    value.count < maximum.count || (value.count == maximum.count && value <= maximum)
  }

  private static func fullMatch(_ expression: NSRegularExpression, _ value: String) -> NSTextCheckingResult? {
    let fullRange = NSRange(value.startIndex..., in: value)
    guard let match = expression.firstMatch(in: value, range: fullRange), match.range == fullRange else { return nil }
    return match
  }

  private static func allowedReadPath(_ pathWithQuery: String) -> Bool {
    if pathWithQuery == "/api/agentflow/me/agent-state" || matches(sessionSnapshotPath, pathWithQuery) { return true }
    if let match = fullMatch(agentEventsPath, pathWithQuery), let sequence = capture(match, 1, in: pathWithQuery),
      let limitText = capture(match, 2, in: pathWithQuery), let limit = Int(limitText) {
      return decimalAtMost(sequence, maximumSafeSequence) && (1...200).contains(limit)
    }
    if let match = fullMatch(agentSessionsPath, pathWithQuery), let limitText = capture(match, 1, in: pathWithQuery),
      let limit = Int(limitText) { return (1...100).contains(limit) }
    if let match = fullMatch(sessionEventsPath, pathWithQuery), let sequence = capture(match, 1, in: pathWithQuery),
      let limitText = capture(match, 2, in: pathWithQuery), let limit = Int(limitText) {
      return decimalAtMost(sequence, maximumSafeSequence) && (1...200).contains(limit)
    }
    if let match = fullMatch(sessionMessagesPath, pathWithQuery), let sequence = capture(match, 1, in: pathWithQuery),
      let limitText = capture(match, 2, in: pathWithQuery), let limit = Int(limitText) {
      return decimalAtMost(sequence, maximumSafeSequence) && (1...20).contains(limit)
    }
    return false
  }

  private static func buildReadRequest(origin: String, pathWithQuery: String, accessToken: String, dpop: String) throws -> URLRequest {
    guard let components = URLComponents(string: origin), components.scheme == "https", let host = components.host,
      host == host.lowercased(), components.port != 443,
      components.user == nil, components.password == nil, components.path.isEmpty, components.query == nil,
      components.fragment == nil, components.url?.absoluteString == origin,
      !pathWithQuery.contains("%"), !pathWithQuery.contains("#"), !pathWithQuery.contains("\\"), allowedReadPath(pathWithQuery),
      accessToken.utf8.count <= 8_192, matches(dpopPattern, accessToken),
      dpop.utf8.count <= 8_192, matches(dpopPattern, dpop),
      let url = URL(string: origin + pathWithQuery), url.absoluteString == origin + pathWithQuery else { throw MobileTransportFailure.invalid }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = "GET"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(dpop, forHTTPHeaderField: "DPoP")
    return request
  }

  private static func safeVersion(_ value: Any?, allowMaximum: Bool) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
    let version = number.doubleValue
    return version.isFinite && version.rounded(.towardZero) == version && version >= 1 &&
      (allowMaximum ? version <= 9_007_199_254_740_991 : version < 9_007_199_254_740_991)
  }

  private static func validTurnBody(_ body: String, path: String, data: Data) -> Bool {
    guard data.count <= maximumTurnRequestBodyBytes, StrictJSONObject.isValid(body),
      let object = try? JSONSerialization.jsonObject(with: data), let fields = object as? [String: Any] else { return false }
    let keys = Set(fields.keys)
    if path.hasSuffix("/turns") {
      guard keys == Set(["input_text", "expected_state_version", "idempotency_key"]) ||
        keys == Set(["input_text", "expected_state_version", "idempotency_key", "origin_id"]),
        let input = fields["input_text"] as? String, !input.isEmpty, input.utf8.count <= 262_144,
        safeVersion(fields["expected_state_version"], allowMaximum: false),
        let key = fields["idempotency_key"] as? String, matches(stableASCII, key) else { return false }
      if let originId = fields["origin_id"] {
        guard let value = originId as? String, (1...128).contains(value.unicodeScalars.count) else { return false }
      }
      return true
    }
    guard path.hasSuffix("/stop"), keys == Set(["turn_id", "expected_state_version"]),
      let turnId = fields["turn_id"] as? String, matches(canonicalUUIDPattern, turnId),
      safeVersion(fields["expected_state_version"], allowMaximum: true) else { return false }
    return true
  }

  private static func buildTurnRequest(origin: String, path: String, accessToken: String, dpop: String, body: String) throws -> URLRequest {
    guard let components = URLComponents(string: origin), components.scheme == "https", let host = components.host,
      host == host.lowercased(), components.port != 443,
      components.user == nil, components.password == nil, components.path.isEmpty, components.query == nil,
      components.fragment == nil, components.url?.absoluteString == origin,
      matches(sessionTurnPath, path), !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"),
      accessToken.utf8.count <= 8_192, matches(dpopPattern, accessToken),
      dpop.utf8.count <= 8_192, matches(dpopPattern, dpop),
      let data = body.data(using: .utf8), validTurnBody(body, path: path, data: data),
      let url = URL(string: origin + path), url.absoluteString == origin + path else { throw MobileTransportFailure.invalid }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(dpop, forHTTPHeaderField: "DPoP")
    request.httpBodyStream = InputStream(data: data)
    return request
  }

  private static func validLifecycleBody(_ body: String, path: String, data: Data) -> Bool {
    guard data.count <= maximumRequestBodyBytes, StrictJSONObject.isValid(body),
      let object = try? JSONSerialization.jsonObject(with: data), let fields = object as? [String: Any] else { return false }
    let keys = Set(fields.keys)
    func codePointString(_ name: String, minimum: Int, maximum: Int) -> Bool {
      guard let value = fields[name] as? String else { return false }
      return (minimum...maximum).contains(value.unicodeScalars.count)
    }
    func expectedVersion() -> Bool {
      guard let number = fields["expected_version"] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
      let value = number.doubleValue
      return value.isFinite && value.rounded(.towardZero) == value && value >= 0 && value < 9_007_199_254_740_991
    }
    if fields["origin_id"] != nil && !codePointString("origin_id", minimum: 1, maximum: 128) { return false }
    switch path {
    case createAgentSessionPath:
      let required = Set(["workflow_id", "expected_version"])
      guard keys == required || keys == required.union(["title"]) || keys == required.union(["origin_id"]) ||
        keys == required.union(["title", "origin_id"]), codePointString("workflow_id", minimum: 1, maximum: 256),
        expectedVersion() else { return false }
      return fields["title"] == nil || codePointString("title", minimum: 0, maximum: 256)
    case switchAgentFocusPath:
      let required = Set(["active_agent_session_id", "expected_version"])
      guard keys == required || keys == required.union(["origin_id"]), expectedVersion(),
        let active = fields["active_agent_session_id"] else { return false }
      return active is NSNull || (active as? String).map { matches(canonicalUUIDPattern, $0) } == true
    default:
      return false
    }
  }

  private static func buildLifecycleRequest(origin: String, path: String, method: String, accessToken: String,
    dpop: String, body: String) throws -> URLRequest {
    let allowed = (method == "POST" && path == createAgentSessionPath) ||
      (method == "PUT" && path == switchAgentFocusPath)
    guard let components = URLComponents(string: origin), components.scheme == "https", let host = components.host,
      host == host.lowercased(), components.port != 443,
      components.user == nil, components.password == nil, components.path.isEmpty, components.query == nil,
      components.fragment == nil, components.url?.absoluteString == origin, allowed,
      !path.contains("%"), !path.contains("?"), !path.contains("#"), !path.contains("\\"),
      accessToken.utf8.count <= 8_192, matches(dpopPattern, accessToken),
      dpop.utf8.count <= 8_192, matches(dpopPattern, dpop),
      let data = body.data(using: .utf8), validLifecycleBody(body, path: path, data: data),
      let url = URL(string: origin + path), url.absoluteString == origin + path else { throw MobileTransportFailure.invalid }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = method
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("DPoP \(accessToken)", forHTTPHeaderField: "Authorization")
    request.setValue(dpop, forHTTPHeaderField: "DPoP")
    request.httpBodyStream = InputStream(data: data)
    return request
  }

  func request(requestId: String, origin: String, path: String, method: String, accessToken: String, body: String?, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    // Validate the complete request before a URLSession or URLSessionTask is created.
    let request = try Self.buildRequest(origin: origin, path: path, method: method, accessToken: accessToken, body: body)
    try execute(requestId: requestId, request: request, maximumResponseBodyBytes: Self.maximumResponseBodyBytes,
      invalidResponseFailure: .unavailable, completion: completion)
  }

  func sessionRequest(requestId: String, origin: String, path: String, method: String, authorization: String?, dpop: String?, body: String?, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    let request = try Self.buildSessionRequest(origin: origin, path: path, method: method, authorization: authorization, dpop: dpop, body: body)
    try execute(requestId: requestId, request: request, maximumResponseBodyBytes: Self.maximumResponseBodyBytes,
      invalidResponseFailure: .unavailable, completion: completion)
  }

  func readRequest(requestId: String, origin: String, pathWithQuery: String, accessToken: String, dpop: String, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    let request = try Self.buildReadRequest(origin: origin, pathWithQuery: pathWithQuery, accessToken: accessToken, dpop: dpop)
    let maximumResponseBodyBytes = Self.matches(Self.sessionMessagesPath, pathWithQuery)
      ? Self.maximumMessagesResponseBodyBytes : Self.maximumResponseBodyBytes
    try execute(requestId: requestId, request: request, maximumResponseBodyBytes: maximumResponseBodyBytes,
      invalidResponseFailure: .responseInvalid, completion: completion)
  }

  func turnRequest(requestId: String, origin: String, path: String, accessToken: String, dpop: String, body: String,
    completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    let request = try Self.buildTurnRequest(origin: origin, path: path, accessToken: accessToken, dpop: dpop, body: body)
    try execute(requestId: requestId, request: request, maximumResponseBodyBytes: Self.maximumResponseBodyBytes,
      invalidResponseFailure: .responseInvalid, completion: completion)
  }

  func lifecycleRequest(requestId: String, origin: String, path: String, method: String, accessToken: String,
    dpop: String, body: String,
    completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    let request = try Self.buildLifecycleRequest(origin: origin, path: path, method: method,
      accessToken: accessToken, dpop: dpop, body: body)
    try execute(requestId: requestId, request: request, maximumResponseBodyBytes: Self.maximumResponseBodyBytes,
      invalidResponseFailure: .responseInvalid, completion: completion)
  }

  private func execute(requestId: String, request: URLRequest, maximumResponseBodyBytes: Int,
    invalidResponseFailure: MobileTransportFailure,
    completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    let handler: (Result<MobileTransportResponse, MobileTransportFailure>) -> Void = { [weak self] result in
      if let self {
        self.lock.lock()
        self.tracked.removeValue(forKey: requestId)
        self.lock.unlock()
      }
      completion(result)
    }
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    let operation = NativeEnrollmentRequest(request: request, maximumResponseBodyBytes: maximumResponseBodyBytes,
      invalidResponseFailure: invalidResponseFailure, fixtureCertificate: fixtureCertificate,
      taskDidComplete: { [taskDidComplete] in taskDidComplete?(requestId) }, completion: handler)
#else
    let operation = NativeEnrollmentRequest(request: request, maximumResponseBodyBytes: maximumResponseBodyBytes,
      invalidResponseFailure: invalidResponseFailure, completion: handler)
#endif
    lock.lock()
    let now = Date()
    pruneLocked(now: now)
    guard let entry = tracked[requestId] else {
      lock.unlock()
      throw MobileTransportFailure.invalid
    }
    if entry.cancelled {
      tracked.removeValue(forKey: requestId)
      lock.unlock()
      throw MobileTransportFailure.unavailable
    }
    guard entry.operation == nil else {
      lock.unlock()
      throw MobileTransportFailure.busy
    }
    entry.touchedAt = now
    entry.operation = operation
    tracked[requestId] = entry
    lock.unlock()
    operation.start()
  }

  func cancelRequest(_ requestId: String) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    lock.lock()
    let now = Date()
    pruneLocked(now: now)
    guard let entry = tracked[requestId] else {
      lock.unlock()
      throw MobileTransportFailure.invalid
    }
    entry.touchedAt = now
    entry.cancelled = true
    tracked[requestId] = entry
    let operation = entry.operation
    lock.unlock()
    operation?.cancel()
  }

  func cancelAll() {
    lock.lock()
    let operations = tracked.values.compactMap { $0.operation }
    tracked.removeAll()
    lock.unlock()
    operations.forEach { $0.cancel() }
  }

  private final class NativeEnrollmentRequest: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    private let request: URLRequest
    private let completion: (Result<MobileTransportResponse, MobileTransportFailure>) -> Void
    private let maximumResponseBodyBytes: Int
    private let invalidResponseFailure: MobileTransportFailure
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var status: Int?
    private var data = Data()
    private var finished = false
    private var cancelled = false
    private var pendingFailure: MobileTransportFailure?
    private let stateLock = NSLock()
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    private let fixtureCertificate: Data?
    private let taskDidComplete: (() -> Void)?
#endif

#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    init(request: URLRequest, maximumResponseBodyBytes: Int, invalidResponseFailure: MobileTransportFailure,
      fixtureCertificate: Data?, taskDidComplete: (() -> Void)?,
      completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) {
      self.request = request
      self.maximumResponseBodyBytes = maximumResponseBodyBytes
      self.invalidResponseFailure = invalidResponseFailure
      self.fixtureCertificate = fixtureCertificate
      self.taskDidComplete = taskDidComplete
      self.completion = completion
    }
#else
    init(request: URLRequest, maximumResponseBodyBytes: Int, invalidResponseFailure: MobileTransportFailure,
      completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) {
      self.request = request
      self.maximumResponseBodyBytes = maximumResponseBodyBytes
      self.invalidResponseFailure = invalidResponseFailure
      self.completion = completion
    }
#endif

    func start() {
      stateLock.lock()
      if cancelled {
        stateLock.unlock()
        finish(.failure(.unavailable))
        return
      }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpCookieStorage = nil
      configuration.httpCookieAcceptPolicy = .never
      configuration.httpShouldSetCookies = false
      configuration.urlCredentialStorage = nil
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.timeoutIntervalForRequest = 10
      configuration.timeoutIntervalForResource = 10
      configuration.waitsForConnectivity = false
      let queue = OperationQueue()
      queue.maxConcurrentOperationCount = 1
      queue.qualityOfService = .userInitiated
      let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
      self.session = session
      let task = session.dataTask(with: request)
      self.task = task
      stateLock.unlock()
      task.resume()
    }

    func cancel() {
      stateLock.lock()
      cancelled = true
      let task = self.task
      stateLock.unlock()
      if let task {
        // Keep the reservation and promise latched until URLSession confirms that the
        // started task has actually completed cancellation on its delegate queue.
        task.cancel()
      } else {
        // A request cancelled before task creation can settle immediately. start() will
        // observe `cancelled` while holding the same lock and will never create or resume it.
        finish(.failure(.unavailable))
      }
    }

    private func finish(_ result: Result<MobileTransportResponse, MobileTransportFailure>) {
      stateLock.lock()
      guard !finished else { stateLock.unlock(); return }
      finished = true
      stateLock.unlock()
      session?.finishTasksAndInvalidate()
      completion(result)
    }

    private func latchFailure(_ failure: MobileTransportFailure) {
      stateLock.lock()
      if !cancelled && pendingFailure == nil { pendingFailure = failure }
      stateLock.unlock()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
      guard let http = response as? HTTPURLResponse, (200...599).contains(http.statusCode), !(300...399).contains(http.statusCode),
        (response.expectedContentLength >= 0 && response.expectedContentLength <= Int64(maximumResponseBodyBytes)) ||
          response.expectedContentLength == NSURLSessionTransferSizeUnknown else {
        latchFailure(invalidResponseFailure)
        completionHandler(.cancel)
        dataTask.cancel()
        return
      }
      status = http.statusCode
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
      guard incoming.count <= maximumResponseBodyBytes,
        data.count <= maximumResponseBodyBytes - incoming.count else {
        latchFailure(invalidResponseFailure)
        dataTask.cancel()
        return
      }
      data.append(incoming)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
      taskDidComplete?()
#endif
      stateLock.lock()
      let pendingFailure = self.pendingFailure
      stateLock.unlock()
      if let pendingFailure {
        finish(.failure(pendingFailure))
        return
      }
      guard error == nil else {
        finish(.failure(.unavailable))
        return
      }
      guard let status, let body = String(data: data, encoding: .utf8) else {
        finish(.failure(invalidResponseFailure))
        return
      }
      finish(.success(MobileTransportResponse(status: status, body: body)))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      latchFailure(invalidResponseFailure)
      completionHandler(nil)
      task.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
      if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
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

    func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
      completionHandler(nil)
    }
  }
}

/** A strict RFC 8259 recognizer that accepts exactly one top-level object. */
private enum StrictJSONObject {
  static func isValid(_ source: String) -> Bool {
    var parser = Parser(bytes: Array(source.utf8))
    return parser.parse()
  }

  private struct Parser {
    let bytes: [UInt8]
    var index = 0

    mutating func parse() -> Bool {
      whitespace()
      guard peek() == 0x7b, value(depth: 0) else { return false }
      whitespace()
      return index == bytes.count
    }

    mutating func value(depth: Int) -> Bool {
      guard depth <= 64 else { return false }
      whitespace()
      switch peek() {
      case 0x7b: return object(depth: depth + 1)
      case 0x5b: return array(depth: depth + 1)
      case 0x22: return string()
      case 0x74: return literal("true")
      case 0x66: return literal("false")
      case 0x6e: return literal("null")
      case 0x2d, 0x30...0x39: return number()
      default: return false
      }
    }

    mutating func object(depth: Int) -> Bool {
      guard take(0x7b) else { return false }
      whitespace()
      if take(0x7d) { return true }
      var keys = Set<String>()
      while true {
        guard peek() == 0x22, let key = stringValue(), keys.insert(key).inserted else { return false }
        whitespace()
        guard take(0x3a), value(depth: depth) else { return false }
        whitespace()
        if take(0x7d) { return true }
        guard take(0x2c) else { return false }
        whitespace()
      }
    }

    mutating func array(depth: Int) -> Bool {
      guard take(0x5b) else { return false }
      whitespace()
      if take(0x5d) { return true }
      while true {
        guard value(depth: depth) else { return false }
        whitespace()
        if take(0x5d) { return true }
        guard take(0x2c) else { return false }
        whitespace()
      }
    }

    mutating func string() -> Bool {
      stringValue() != nil
    }

    mutating func stringValue() -> String? {
      let start = index
      guard take(0x22) else { return nil }
      while index < bytes.count {
        let byte = bytes[index]
        index += 1
        if byte == 0x22 {
          let encoded = Data(bytes[start..<index])
          return (try? JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed])) as? String
        }
        if byte < 0x20 { return nil }
        if byte == 0x5c, !escape() { return nil }
      }
      return nil
    }

    mutating func escape() -> Bool {
      guard index < bytes.count else { return false }
      let byte = bytes[index]
      index += 1
      if [0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(byte) { return true }
      guard byte == 0x75, let scalar = hexQuad() else { return false }
      if (0xd800...0xdbff).contains(scalar) {
        guard take(0x5c), take(0x75), let low = hexQuad(), (0xdc00...0xdfff).contains(low) else { return false }
      } else if (0xdc00...0xdfff).contains(scalar) {
        return false
      }
      return true
    }

    mutating func hexQuad() -> Int? {
      var result = 0
      for _ in 0..<4 {
        guard index < bytes.count else { return nil }
        let value: Int
        switch bytes[index] {
        case 0x30...0x39: value = Int(bytes[index] - 0x30)
        case 0x41...0x46: value = Int(bytes[index] - 0x41 + 10)
        case 0x61...0x66: value = Int(bytes[index] - 0x61 + 10)
        default: return nil
        }
        index += 1
        result = result * 16 + value
      }
      return result
    }

    mutating func number() -> Bool {
      _ = take(0x2d)
      if take(0x30) {
        if (0x30...0x39).contains(peek()) { return false }
      } else {
        guard (0x31...0x39).contains(peek()) else { return false }
        repeat { index += 1 } while (0x30...0x39).contains(peek())
      }
      if take(0x2e) {
        guard (0x30...0x39).contains(peek()) else { return false }
        repeat { index += 1 } while (0x30...0x39).contains(peek())
      }
      if peek() == 0x65 || peek() == 0x45 {
        index += 1
        if peek() == 0x2b || peek() == 0x2d { index += 1 }
        guard (0x30...0x39).contains(peek()) else { return false }
        repeat { index += 1 } while (0x30...0x39).contains(peek())
      }
      return true
    }

    mutating func literal(_ value: String) -> Bool {
      let expected = Array(value.utf8)
      guard index + expected.count <= bytes.count,
        Array(bytes[index..<(index + expected.count)]) == expected else { return false }
      index += expected.count
      return true
    }

    mutating func whitespace() {
      while [0x20, 0x09, 0x0a, 0x0d].contains(peek()) { index += 1 }
    }

    func peek() -> UInt8 { index < bytes.count ? bytes[index] : 0xff }

    mutating func take(_ expected: UInt8) -> Bool {
      guard peek() == expected else { return false }
      index += 1
      return true
    }
  }
}
