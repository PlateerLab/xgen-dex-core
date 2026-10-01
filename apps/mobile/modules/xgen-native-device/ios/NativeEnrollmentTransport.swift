import Foundation
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
import Security
#endif

enum MobileTransportFailure: Error {
  case invalid
  case unavailable
  case busy

  var code: String {
    switch self {
    case .invalid: return "mobile_transport_invalid"
    case .unavailable: return "mobile_transport_unavailable"
    case .busy: return "mobile_transport_busy"
    }
  }
}

struct MobileTransportResponse {
  let status: Int
  let body: String
}

final class NativeEnrollmentTransport {
  private static let maximumRequestBodyBytes = 32_768
  private static let maximumResponseBodyBytes = 65_536
  private static let maximumTrackedRequests = 1_024
  private static let reservationTTL: TimeInterval = 60
  private static let accessTokenPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9._~-]{1,8192}$")
  private static let statusPath = try! NSRegularExpression(pattern: "^/api/auth/platform-devices/native/mobile/registration/status/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  private static let approvalBeginPath = try! NSRegularExpression(pattern: "^/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests/begin$")
  private static let approvalPath = try! NSRegularExpression(pattern: "^/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests$")

  private let lock = NSLock()
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
  private let fixtureCertificate: Data?
  init(fixtureCertificate: Data? = nil) { self.fixtureCertificate = fixtureCertificate }
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
    expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
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

  func request(requestId: String, origin: String, path: String, method: String, accessToken: String, body: String?, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) throws {
    guard Self.isCanonicalUUID(requestId) else { throw MobileTransportFailure.invalid }
    // Validate the complete request before a URLSession or URLSessionTask is created.
    let request = try Self.buildRequest(origin: origin, path: path, method: method, accessToken: accessToken, body: body)
    let handler: (Result<MobileTransportResponse, MobileTransportFailure>) -> Void = { [weak self] result in
      if let self {
        self.lock.lock()
        self.tracked.removeValue(forKey: requestId)
        self.lock.unlock()
      }
      completion(result)
    }
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    let operation = NativeEnrollmentRequest(request: request, fixtureCertificate: fixtureCertificate, completion: handler)
#else
    let operation = NativeEnrollmentRequest(request: request, completion: handler)
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
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var status: Int?
    private var data = Data()
    private var finished = false
    private var cancelled = false
    private let stateLock = NSLock()
#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    private let fixtureCertificate: Data?
#endif

#if NATIVE_ENROLLMENT_TRANSPORT_TESTING
    init(request: URLRequest, fixtureCertificate: Data?, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) {
      self.request = request
      self.fixtureCertificate = fixtureCertificate
      self.completion = completion
    }
#else
    init(request: URLRequest, completion: @escaping (Result<MobileTransportResponse, MobileTransportFailure>) -> Void) {
      self.request = request
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
      task?.cancel()
      finish(.failure(.unavailable))
    }

    private func finish(_ result: Result<MobileTransportResponse, MobileTransportFailure>) {
      stateLock.lock()
      guard !finished else { stateLock.unlock(); return }
      finished = true
      stateLock.unlock()
      session?.finishTasksAndInvalidate()
      completion(result)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
      guard let http = response as? HTTPURLResponse, (200...599).contains(http.statusCode), !(300...399).contains(http.statusCode),
        response.expectedContentLength <= NativeEnrollmentTransport.maximumResponseBodyBytes || response.expectedContentLength == NSURLSessionTransferSizeUnknown else {
        completionHandler(.cancel)
        finish(.failure(.unavailable))
        return
      }
      status = http.statusCode
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive incoming: Data) {
      guard incoming.count <= NativeEnrollmentTransport.maximumResponseBodyBytes,
        data.count <= NativeEnrollmentTransport.maximumResponseBodyBytes - incoming.count else {
        dataTask.cancel()
        finish(.failure(.unavailable))
        return
      }
      data.append(incoming)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard error == nil, let status, let body = String(data: data, encoding: .utf8) else {
        finish(.failure(.unavailable))
        return
      }
      finish(.success(MobileTransportResponse(status: status, body: body)))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      completionHandler(nil)
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
      while true {
        guard peek() == 0x22, string() else { return false }
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
      guard take(0x22) else { return false }
      while index < bytes.count {
        let byte = bytes[index]
        index += 1
        if byte == 0x22 { return true }
        if byte < 0x20 { return false }
        if byte == 0x5c, !escape() { return false }
      }
      return false
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
