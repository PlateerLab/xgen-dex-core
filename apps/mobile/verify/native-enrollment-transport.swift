import Foundation
import CryptoKit

private enum VerificationFailure: Error { case failed(String) }

@main
struct NativeEnrollmentTransportVerification {
  static func main() throws {
    guard CommandLine.arguments.count == 3 else { throw VerificationFailure.failed("expected HTTPS origin and fixture certificate") }
    let origin = CommandLine.arguments[1]
    let nativeCompletionLock = NSLock()
    var completedNativeTaskIds = Set<String>()
    let transport = NativeEnrollmentTransport(
      fixtureCertificate: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])),
      taskDidComplete: { requestId in
        nativeCompletionLock.lock()
        completedNativeTaskIds.insert(requestId)
        nativeCompletionLock.unlock()
      })
    func nativeTaskCompleted(_ requestId: String) -> Bool {
      nativeCompletionLock.lock(); defer { nativeCompletionLock.unlock() }
      return completedNativeTaskIds.contains(requestId)
    }

    func perform(_ path: String, method: String = "GET", accessToken: String = "fixture-token_123~safe", body: String? = nil,
      cancelAfter: TimeInterval? = nil, onReserved: ((String) -> Void)? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      onReserved?(id)
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.request(requestId: id, origin: origin, path: path, method: method, accessToken: accessToken, body: body) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter {
        DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) }
      }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("request timeout") }
      return result
    }

    func performSession(_ path: String, method: String = "POST", authorization: String? = nil, dpop: String? = nil, body: String? = "{}",
      cancelAfter: TimeInterval? = nil, onReserved: ((String) -> Void)? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      onReserved?(id)
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.sessionRequest(requestId: id, origin: origin, path: path, method: method, authorization: authorization, dpop: dpop, body: body) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter { DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) } }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("session request timeout") }
      return result
    }

    func performRead(_ pathWithQuery: String, accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature",
      cancelAfter: TimeInterval? = nil, onReserved: ((String) -> Void)? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      onReserved?(id)
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.readRequest(requestId: id, origin: origin, pathWithQuery: pathWithQuery, accessToken: accessToken, dpop: dpop) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter { DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) } }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("read request timeout") }
      return result
    }

    func performTurn(_ path: String, body: String, accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature",
      cancelAfter: TimeInterval? = nil, onReserved: ((String) -> Void)? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      onReserved?(id)
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.turnRequest(requestId: id, origin: origin, path: path, accessToken: accessToken, dpop: dpop, body: body) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter { DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) } }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("turn request timeout") }
      return result
    }

    func performLifecycle(_ path: String, method: String, body: String,
      accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature",
      cancelAfter: TimeInterval? = nil, onReserved: ((String) -> Void)? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      onReserved?(id)
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.lifecycleRequest(requestId: id, origin: origin, path: path, method: method,
        accessToken: accessToken, dpop: dpop, body: body) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter { DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) } }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("lifecycle request timeout") }
      return result
    }

    let headers = try perform("/api/auth/platform-devices/native/mobile/registration/challenge", method: "POST", body: "{\"case\":\"headers\"}").get()
    guard headers.status == 201, headers.body == "{\"ok\":true}" else { throw VerificationFailure.failed("headers/body") }

    let cookie = try perform("/api/auth/platform-devices/native/mobile/registration/complete", method: "POST", body: "{}").get()
    guard cookie.status == 200, cookie.body == "{\"cookie\":false}" else { throw VerificationFailure.failed("cookie isolation") }

    guard case .failure = try perform("/api/auth/platform-devices/trust-overview") else { throw VerificationFailure.failed("redirect followed") }
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000001") else { throw VerificationFailure.failed("oversize accepted") }
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000002") else { throw VerificationFailure.failed("invalid UTF-8 accepted") }

    let cancelStarted = Date()
    var enrollmentCancelId = ""
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000003",
      cancelAfter: 0.1, onReserved: { enrollmentCancelId = $0 }),
      Date().timeIntervalSince(cancelStarted) < 2,
      nativeTaskCompleted(enrollmentCancelId) else {
      throw VerificationFailure.failed("cancel completed before URLSession settled")
    }

    guard case .failure = try perform("/api/me/devices/native/mobile/00000000-0000-0000-0000-000000000001/approval-requests/begin", method: "POST", body: "{\"case\":\"disconnect\"}") else {
      throw VerificationFailure.failed("disconnected POST succeeded")
    }
    Thread.sleep(forTimeInterval: 0.5)
    let count = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000004").get()
    guard count.body == "{\"disconnectedPosts\":1}" else { throw VerificationFailure.failed("POST body was replayed") }

    let sessionLogin = try performSession("/api/auth/platform-sessions/native/login-key/begin", authorization: "Bearer fixture-token_123~safe", body: "{\"case\":\"session-headers\"}").get()
    guard sessionLogin.status == 201, sessionLogin.body == "{\"session\":true}" else { throw VerificationFailure.failed("session login policy") }
    let refresh = try performSession("/api/auth/platform-sessions/native/refresh/begin").get()
    guard refresh.status == 200, refresh.body == "{\"cookie\":false}" else { throw VerificationFailure.failed("session credential isolation") }
    let deleted = try performSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", method: "DELETE", authorization: "DPoP fixture.access.token", dpop: "fixture.header.signature", body: "{\"password\":\"fixture-password\"}").get()
    guard deleted.status == 204, deleted.body.isEmpty else { throw VerificationFailure.failed("session delete policy") }

    guard case .failure = try performSession("/api/auth/platform-sessions/native/login-key/complete", authorization: "Bearer fixture-token_123~safe", body: "{\"case\":\"disconnect\"}") else {
      throw VerificationFailure.failed("disconnected session POST succeeded")
    }
    Thread.sleep(forTimeInterval: 0.5)
    let sessionCount = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000004").get()
    guard sessionCount.body == "{\"disconnectedPosts\":2}" else { throw VerificationFailure.failed("session POST body was replayed") }

    let sessionCancelStarted = Date()
    var sessionCancelId = ""
    guard case .failure = try performSession("/api/auth/platform-sessions/native/refresh/complete", body: "{\"case\":\"delay\"}",
      cancelAfter: 0.1, onReserved: { sessionCancelId = $0 }),
      Date().timeIntervalSince(sessionCancelStarted) < 2,
      nativeTaskCompleted(sessionCancelId) else {
      throw VerificationFailure.failed("session cancel completed before URLSession settled")
    }

    let canonicalSession = "00000000-0000-4000-8000-000000000001"
    let canonicalReads = [
      "/api/agentflow/me/agent-state",
      "/api/agentflow/me/agent-events?after_sequence=9007199254740991&limit=200",
      "/api/agentflow/me/agent-sessions?limit=100",
      "/api/agentflow/me/agent-sessions?limit=20&before_id=\(canonicalSession)",
      "/api/agentflow/agent-sessions/\(canonicalSession)/snapshot",
      "/api/agentflow/agent-sessions/\(canonicalSession)/events?after_sequence=0&limit=1",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence=9007199254740991&limit=20",
    ]
    for path in canonicalReads {
      let read = try performRead(path).get()
      guard read.status == 200, read.body == "{\"read\":true}" else { throw VerificationFailure.failed("canonical read policy") }
    }
    let messagesBase = "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence="
    let readCancelStarted = Date()
    var readCancelId = ""
    guard case .failure(.unavailable) = try performRead(messagesBase + "6&limit=1", cancelAfter: 0.1,
      onReserved: { readCancelId = $0 }),
      Date().timeIntervalSince(readCancelStarted) < 2,
      nativeTaskCompleted(readCancelId) else {
      throw VerificationFailure.failed("read cancel completed before URLSession settled")
    }

    let largeMessages = try performRead(messagesBase + "1&limit=20").get()
    guard largeMessages.body.utf8.count == 70_000 else { throw VerificationFailure.failed("messages response cap") }
    func expectInvalidResponse(_ path: String) throws {
      guard case .failure(.responseInvalid) = try performRead(path) else {
        throw VerificationFailure.failed("malformed canonical response was retryable")
      }
    }
    try expectInvalidResponse("/api/agentflow/me/agent-events?after_sequence=8&limit=1")
    try expectInvalidResponse(messagesBase + "2&limit=20")
    try expectInvalidResponse(messagesBase + "3&limit=20")
    try expectInvalidResponse(messagesBase + "4&limit=20")
    try expectInvalidResponse(messagesBase + "5&limit=20")

    let turnPath = "/api/agentflow/agent-sessions/\(canonicalSession)/turns"
    let stopPath = "/api/agentflow/agent-sessions/\(canonicalSession)/stop"
    let turnBody = "{\"input_text\":\"hello\\nworld\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\",\"origin_id\":\"mobile-1\"}"
    let turnAck = try performTurn(turnPath, body: turnBody).get()
    guard turnAck.status == 202, turnAck.body == "{\"accepted\":true}" else { throw VerificationFailure.failed("turn headers/body") }
    let stopBody = "{\"turn_id\":\"00000000-0000-4000-8000-000000000002\",\"expected_state_version\":2}"
    let stopAck = try performTurn(stopPath, body: stopBody).get()
    guard stopAck.status == 200, stopAck.body == "{\"requested\":true,\"disconnectedTurnPosts\":0}" else {
      throw VerificationFailure.failed("turn cookie/header isolation")
    }
    func expectInvalidTurn(_ path: String = turnPath, body: String = turnBody,
      accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature") throws {
      do {
        _ = try performTurn(path, body: body, accessToken: accessToken, dpop: dpop)
        throw VerificationFailure.failed("invalid turn request accepted")
      } catch MobileTransportFailure.invalid {}
    }
    try expectInvalidTurn("/api/agentflow/agent-sessions/\(canonicalSession)/messages")
    try expectInvalidTurn(turnPath + "?x=1")
    try expectInvalidTurn(body: "{\"input_text\":\"x\",\"input_text\":\"y\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\"}")
    try expectInvalidTurn(body: "{\"input_text\":\"x\",\"\\u0069nput_text\":\"y\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\"}")
    try expectInvalidTurn(body: "{\"input_text\":\"x\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\",\"private\":true}")
    try expectInvalidTurn(body: "{\"input_text\":\"\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\"}")
    try expectInvalidTurn(body: "{\"input_text\":\"x\",\"expected_state_version\":0,\"idempotency_key\":\"request-1\"}")
    try expectInvalidTurn(body: "{\"input_text\":\"x\",\"expected_state_version\":1,\"idempotency_key\":\"bad key\"}")
    try expectInvalidTurn(body: "{\"input_text\":\"\(String(repeating: "x", count: 262_145))\",\"expected_state_version\":1,\"idempotency_key\":\"request-1\"}")
    try expectInvalidTurn(stopPath, body: "{\"turn_id\":\"not-a-turn\",\"expected_state_version\":1}")
    try expectInvalidTurn(stopPath, body: "{\"turn_id\":\"00000000-0000-0000-0000-000000000002\",\"expected_state_version\":1}")
    try expectInvalidTurn(stopPath, body: "{\"turn_id\":\"00000000-0000-4000-8000-000000000002\",\"expected_state_version\":9007199254740992}")
    try expectInvalidTurn(accessToken: "opaque-token")
    try expectInvalidTurn(dpop: "opaque-proof")
    let uppercaseTurnOriginId = try transport.newRequestId()
    do {
      try transport.turnRequest(requestId: uppercaseTurnOriginId, origin: origin.replacingOccurrences(of: "localhost", with: "LOCALHOST"),
        path: turnPath, accessToken: "fixture.access.token", dpop: "fixture.header.signature", body: turnBody) { _ in }
      throw VerificationFailure.failed("noncanonical turn origin accepted")
    } catch MobileTransportFailure.invalid {}

    let escapedBody = "{\"input_text\":\"\(String(repeating: "\\u0000", count: 262_144))\",\"expected_state_version\":1,\"idempotency_key\":\"request-escaped\"}"
    guard escapedBody.utf8.count < 2_097_152, try performTurn(turnPath, body: escapedBody).get().status == 202 else {
      throw VerificationFailure.failed("worst-case escaped turn input")
    }
    for value in ["large-ack", "invalid-ack", "redirect"] {
      let body = "{\"input_text\":\"\(value)\",\"expected_state_version\":1,\"idempotency_key\":\"request-\(value)\"}"
      var rejectedTurnId = ""
      guard case .failure(.responseInvalid) = try performTurn(turnPath, body: body, onReserved: { rejectedTurnId = $0 }),
        nativeTaskCompleted(rejectedTurnId) else {
        throw VerificationFailure.failed("invalid turn ACK completed before URLSession settled")
      }
    }
    let turnCancelStarted = Date()
    var turnCancelId = ""
    guard case .failure(.unavailable) = try performTurn(turnPath,
      body: "{\"input_text\":\"delayed\",\"expected_state_version\":1,\"idempotency_key\":\"request-delayed\"}", cancelAfter: 0.1,
      onReserved: { turnCancelId = $0 }),
      Date().timeIntervalSince(turnCancelStarted) < 2,
      nativeTaskCompleted(turnCancelId) else {
      throw VerificationFailure.failed("turn cancel completed before URLSession settled")
    }
    guard case .failure = try performTurn(turnPath,
      body: "{\"input_text\":\"lost\",\"expected_state_version\":1,\"idempotency_key\":\"request-lost\"}") else {
      throw VerificationFailure.failed("lost turn ACK succeeded")
    }
    Thread.sleep(forTimeInterval: 0.5)
    let afterLost = try performTurn(stopPath, body: stopBody).get()
    guard afterLost.body == "{\"requested\":true,\"disconnectedTurnPosts\":1}" else {
      throw VerificationFailure.failed("lost turn body was replayed")
    }

    let createPath = "/api/agentflow/agent-sessions"
    let focusPath = "/api/agentflow/me/agent-state"
    let createBody = "{\"workflow_id\":\"create\",\"expected_version\":0,\"title\":\"\",\"origin_id\":\"mobile-1\"}"
    guard try performLifecycle(createPath, method: "POST", body: createBody).get().status == 201,
      try performLifecycle(focusPath, method: "PUT", body: "{\"active_agent_session_id\":null,\"expected_version\":0}").get().body ==
        "{\"focused\":true,\"disconnectedLifecyclePosts\":0}" else {
      throw VerificationFailure.failed("lifecycle TLS method/header/body/cookie policy")
    }
    func expectInvalidLifecycle(_ path: String = createPath, method: String = "POST", body: String = createBody,
      accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature") throws {
      do {
        _ = try performLifecycle(path, method: method, body: body, accessToken: accessToken, dpop: dpop)
        throw VerificationFailure.failed("invalid lifecycle request accepted")
      } catch MobileTransportFailure.invalid {}
    }
    try expectInvalidLifecycle(method: "PUT")
    try expectInvalidLifecycle(focusPath, method: "POST")
    try expectInvalidLifecycle(createPath + "?x=1")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"a\",\"workflow_id\":\"b\",\"expected_version\":0}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"a\",\"\\u0077orkflow_id\":\"b\",\"expected_version\":0}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"\\uD800\",\"expected_version\":0}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"\",\"expected_version\":0}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"\(String(repeating: "😀", count: 257))\",\"expected_version\":0}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"a\",\"expected_version\":9007199254740991}")
    try expectInvalidLifecycle(body: "{\"workflow_id\":\"a\",\"expected_version\":0,\"title\":\"\(String(repeating: "x", count: 32_769))\"}")
    try expectInvalidLifecycle(body: String(repeating: " ", count: 32_768) + createBody)
    try expectInvalidLifecycle(focusPath, method: "PUT", body: "{\"active_agent_session_id\":false,\"expected_version\":0}")
    try expectInvalidLifecycle(focusPath, method: "PUT", body: "{\"active_agent_session_id\":\"00000000-0000-0000-0000-000000000001\",\"expected_version\":0}")
    try expectInvalidLifecycle(accessToken: "opaque-token")
    try expectInvalidLifecycle(dpop: "opaque-proof")
    for value in ["large-ack", "invalid-ack", "redirect"] {
      guard case .failure(.responseInvalid) = try performLifecycle(createPath, method: "POST",
        body: "{\"workflow_id\":\"\(value)\",\"expected_version\":0}") else {
        throw VerificationFailure.failed("invalid lifecycle ACK accepted")
      }
    }
    var lifecycleCancelId = ""
    guard case .failure(.unavailable) = try performLifecycle(createPath, method: "POST",
      body: "{\"workflow_id\":\"delayed\",\"expected_version\":0}", cancelAfter: 0.1,
      onReserved: { lifecycleCancelId = $0 }), nativeTaskCompleted(lifecycleCancelId) else {
      throw VerificationFailure.failed("lifecycle cancel completed before URLSession settled")
    }
    guard case .failure = try performLifecycle(createPath, method: "POST",
      body: "{\"workflow_id\":\"lost\",\"expected_version\":0}") else {
      throw VerificationFailure.failed("lost lifecycle ACK succeeded")
    }
    Thread.sleep(forTimeInterval: 0.5)
    guard try performLifecycle(focusPath, method: "PUT",
      body: "{\"active_agent_session_id\":null,\"expected_version\":0}").get().body ==
        "{\"focused\":true,\"disconnectedLifecyclePosts\":1}" else {
      throw VerificationFailure.failed("lifecycle write body was replayed")
    }

    func expectInvalidRead(_ path: String, accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature") throws {
      do {
        _ = try performRead(path, accessToken: accessToken, dpop: dpop)
        throw VerificationFailure.failed("invalid canonical read accepted")
      } catch MobileTransportFailure.invalid {}
    }
    for path in [
      "/api/agentflow/me/agent-state?x=1",
      "/api/agentflow/me/agent-events",
      "/api/agentflow/me/agent-events?limit=1&after_sequence=0",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=1&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=01&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=9007199254740992&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=0",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=201",
      "/api/agentflow/me/agent-sessions?limit=101",
      "/api/agentflow/me/agent-sessions?before_id=\(canonicalSession)&limit=1",
      "/api/agentflow/me/agent-sessions?limit=1&before_id=00000000-0000-0000-0000-000000000001",
      "/api/agentflow/me/agent-sessions?limit=1&before_id=00000000-0000-4000-8000-00000000000A",
      "/api/agentflow/agent-sessions/\(canonicalSession)/events?after_sequence=0&limit=01",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?limit=1&after_sequence=0",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence=0&limit=1&limit=1",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence=01&limit=1",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence=9007199254740992&limit=1",
      "/api/agentflow/agent-sessions/\(canonicalSession)/messages?after_sequence=0&limit=21",
      "/api/agentflow/agent-sessions/\(canonicalSession)/snapshot?x=1",
      "/api/agentflow/me/agent-events?after_sequence=0%26limit=1&limit=1",
      "/api/agentflow/me/agent-state#fragment",
      "/api/agentflow/me\\agent-state",
    ] { try expectInvalidRead(path) }
    try expectInvalidRead("/api/agentflow/me/agent-state", accessToken: "fixture.access.token\n")
    try expectInvalidRead("/api/agentflow/me/agent-state", dpop: "fixture.header.signature\n")
    try expectInvalidRead("/api/agentflow/me/agent-state", accessToken: "opaque-token")
    try expectInvalidRead("/api/agentflow/me/agent-state", dpop: "opaque-proof")
    try expectInvalidRead("/api/agentflow/me/agent-state", accessToken: String(repeating: "a", count: 8_189) + ".b.c")
    let uppercaseOriginId = try transport.newRequestId()
    do {
      try transport.readRequest(requestId: uppercaseOriginId, origin: origin.replacingOccurrences(of: "localhost", with: "LOCALHOST"),
        pathWithQuery: "/api/agentflow/me/agent-state", accessToken: "fixture.access.token", dpop: "fixture.header.signature") { _ in }
      throw VerificationFailure.failed("noncanonical read origin accepted")
    } catch MobileTransportFailure.invalid {}
    let defaultPortOriginId = try transport.newRequestId()
    do {
      try transport.readRequest(requestId: defaultPortOriginId, origin: "https://localhost:443",
        pathWithQuery: "/api/agentflow/me/agent-state", accessToken: "fixture.access.token", dpop: "fixture.header.signature") { _ in }
      throw VerificationFailure.failed("default-port read origin accepted")
    } catch MobileTransportFailure.invalid {}

    do {
      _ = try performSession("/api/auth/platform-sessions/native/login-key/begin", authorization: nil)
      throw VerificationFailure.failed("missing session auth accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try performSession("/api/agentflow/me/agent-state", method: "GET", authorization: "DPoP safe", dpop: "a.b.c", body: nil)
      throw VerificationFailure.failed("session GET transport accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try performSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", method: "DELETE", authorization: "DPoP fixture.access.token", dpop: "fixture.header.signature", body: nil)
      throw VerificationFailure.failed("bodyless session DELETE accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try performSession("/api/me/platform-sessions/00000000-0000-0000-0000-000000000001", method: "DELETE", authorization: "DPoP fixture.access.token", dpop: "fixture.header.signature", body: "{}")
      throw VerificationFailure.failed("noncanonical session UUID accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try perform("/api/auth/platform-devices/native/mobile/registration/challenge", method: "POST", accessToken: "fixture-token_123~safe\n", body: "{}")
      throw VerificationFailure.failed("newline-suffixed enrollment token accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try performSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", method: "DELETE", authorization: "DPoP fixture.access.token\n", dpop: "fixture.header.signature", body: "{}")
      throw VerificationFailure.failed("newline-suffixed DPoP access token accepted")
    } catch MobileTransportFailure.invalid {}
    do {
      _ = try performSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", method: "DELETE", authorization: "DPoP fixture.access.token", dpop: "fixture.header.signature\n", body: "{}")
      throw VerificationFailure.failed("newline-suffixed DPoP proof accepted")
    } catch MobileTransportFailure.invalid {}

    let cancelledId = try transport.newRequestId()
    try transport.cancelRequest(cancelledId)
    do {
      try transport.request(requestId: cancelledId, origin: origin, path: "/api/auth/platform-devices/trust-overview", method: "GET", accessToken: "fixture-token_123~safe", body: nil) { _ in }
      throw VerificationFailure.failed("cancel-before-request opened")
    } catch MobileTransportFailure.unavailable {}

    let softwareKey = P256.Signing.PrivateKey()
    let point = softwareKey.publicKey.rawRepresentation
    let x = DeviceProof.encode(point.subdata(in: 1..<33))
    let y = DeviceProof.encode(point.subdata(in: 33..<65))
    let dpopOrigin = "https://xgen.example.test"
    let dpopHtu = dpopOrigin + "/api/me/platform-sessions/00000000-0000-4000-8000-000000000001"
    let dpopJti = "00000000-0000-0000-0000-000000000002"
    let proof = try DpopProof.create(origin: dpopOrigin, method: "DELETE", htu: dpopHtu, accessToken: "access.safe.jwt", x: x, y: y,
      nowSeconds: 1_700_000_000, jti: dpopJti) { try softwareKey.signature(for: $0).rawRepresentation }
    let parts = proof.split(separator: ".").map(String.init)
    func decode(_ value: String) -> Data? {
      var padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
      padded += String(repeating: "=", count: (4 - padded.count % 4) % 4)
      return Data(base64Encoded: padded)
    }
    guard parts.count == 3, let headerData = decode(parts[0]), let claimsData = decode(parts[1]),
      let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
      let claims = try JSONSerialization.jsonObject(with: claimsData) as? [String: Any],
      header["typ"] as? String == "dpop+jwt", claims["htm"] as? String == "DELETE", claims["htu"] as? String == dpopHtu,
      claims["jti"] as? String == dpopJti, claims["iat"] as? Int == 1_700_000_000,
      let signatureData = decode(parts[2]),
      softwareKey.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: signatureData), for: Data("\(parts[0]).\(parts[1])".utf8)) else {
      throw VerificationFailure.failed("DPoP signature or claims")
    }
    let expectedAth = DeviceProof.encode(Data(SHA256.hash(data: Data("access.safe.jwt".utf8))))
    guard claims["ath"] as? String == expectedAth else { throw VerificationFailure.failed("DPoP ath") }
    let messagesHtu = dpopOrigin + "/api/agentflow/agent-sessions/\(canonicalSession)/messages"
    let messagesInput = try DpopProof.signingInput(origin: dpopOrigin, method: "GET", htu: messagesHtu,
      accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
    guard let messagesClaimsData = decode(String(messagesInput.split(separator: ".")[1])),
      let messagesClaims = try JSONSerialization.jsonObject(with: messagesClaimsData) as? [String: Any],
      messagesClaims["htu"] as? String == messagesHtu, messagesClaims["htm"] as? String == "GET" else {
      throw VerificationFailure.failed("messages DPoP claims")
    }
    let turnHtu = dpopOrigin + "/api/agentflow/agent-sessions/\(canonicalSession)/turns"
    let turnInput = try DpopProof.signingInput(origin: dpopOrigin, method: "POST", htu: turnHtu,
      accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
    guard let turnClaimsData = decode(String(turnInput.split(separator: ".")[1])),
      let turnClaims = try JSONSerialization.jsonObject(with: turnClaimsData) as? [String: Any],
      turnClaims["htu"] as? String == turnHtu, turnClaims["htm"] as? String == "POST" else {
      throw VerificationFailure.failed("turn DPoP claims")
    }
    let createHtu = dpopOrigin + createPath
    let createInput = try DpopProof.signingInput(origin: dpopOrigin, method: "POST", htu: createHtu,
      accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
    let focusHtu = dpopOrigin + focusPath
    let focusInput = try DpopProof.signingInput(origin: dpopOrigin, method: "PUT", htu: focusHtu,
      accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
    guard let createClaimsData = decode(String(createInput.split(separator: ".")[1])),
      let createClaims = try JSONSerialization.jsonObject(with: createClaimsData) as? [String: Any],
      createClaims["htu"] as? String == createHtu, createClaims["htm"] as? String == "POST",
      let focusClaimsData = decode(String(focusInput.split(separator: ".")[1])),
      let focusClaims = try JSONSerialization.jsonObject(with: focusClaimsData) as? [String: Any],
      focusClaims["htu"] as? String == focusHtu, focusClaims["htm"] as? String == "PUT" else {
      throw VerificationFailure.failed("lifecycle DPoP claims")
    }
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "PUT", htu: createHtu,
        accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("lifecycle DPoP route/method mismatch accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "GET",
        htu: messagesHtu + "?after_sequence=0&limit=20", accessToken: "access.safe.jwt", x: x, y: y,
        nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("messages DPoP query accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "GET", htu: dpopHtu + "?x=1", accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("unsafe DPoP htu accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "POST", htu: dpopHtu, accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("unlisted DPoP method accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "POST", htu: messagesHtu, accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("POST proof for read path accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "DELETE", htu: dpopHtu, accessToken: "opaque-safe-token", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("opaque DPoP access token accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "DELETE", htu: dpopHtu, accessToken: "access.safe.jwt\n", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("newline-suffixed DPoP signer token accepted")
    } catch DeviceKeyFailure.invalid {}

    print("native enrollment/session/canonical URLSession and DPoP verification passed")
  }
}
