import Foundation
import CryptoKit

private enum VerificationFailure: Error { case failed(String) }

@main
struct NativeEnrollmentTransportVerification {
  static func main() throws {
    guard CommandLine.arguments.count == 3 else { throw VerificationFailure.failed("expected HTTPS origin and fixture certificate") }
    let origin = CommandLine.arguments[1]
    let transport = NativeEnrollmentTransport(fixtureCertificate: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))

    func perform(_ path: String, method: String = "GET", accessToken: String = "fixture-token_123~safe", body: String? = nil, cancelAfter: TimeInterval? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
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

    func performSession(_ path: String, method: String = "POST", authorization: String? = nil, dpop: String? = nil, body: String? = "{}", cancelAfter: TimeInterval? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
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

    func performRead(_ pathWithQuery: String, accessToken: String = "fixture.access.token", dpop: String = "fixture.header.signature", cancelAfter: TimeInterval? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
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

    let headers = try perform("/api/auth/platform-devices/native/mobile/registration/challenge", method: "POST", body: "{\"case\":\"headers\"}").get()
    guard headers.status == 201, headers.body == "{\"ok\":true}" else { throw VerificationFailure.failed("headers/body") }

    let cookie = try perform("/api/auth/platform-devices/native/mobile/registration/complete", method: "POST", body: "{}").get()
    guard cookie.status == 200, cookie.body == "{\"cookie\":false}" else { throw VerificationFailure.failed("cookie isolation") }

    guard case .failure = try perform("/api/auth/platform-devices/trust-overview") else { throw VerificationFailure.failed("redirect followed") }
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000001") else { throw VerificationFailure.failed("oversize accepted") }
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000002") else { throw VerificationFailure.failed("invalid UTF-8 accepted") }

    let cancelStarted = Date()
    guard case .failure = try perform("/api/auth/platform-devices/native/mobile/registration/status/00000000-0000-0000-0000-000000000003", cancelAfter: 0.1),
      Date().timeIntervalSince(cancelStarted) < 2 else { throw VerificationFailure.failed("cancel did not interrupt") }

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
    guard case .failure = try performSession("/api/auth/platform-sessions/native/refresh/complete", body: "{\"case\":\"delay\"}", cancelAfter: 0.1),
      Date().timeIntervalSince(sessionCancelStarted) < 2 else { throw VerificationFailure.failed("session cancel did not interrupt") }

    let canonicalSession = "00000000-0000-4000-8000-000000000001"
    let canonicalReads = [
      "/api/agentflow/me/agent-state",
      "/api/agentflow/me/agent-events?after_sequence=9007199254740991&limit=200",
      "/api/agentflow/me/agent-sessions?limit=100",
      "/api/agentflow/me/agent-sessions?limit=20&before_id=\(canonicalSession)",
      "/api/agentflow/agent-sessions/\(canonicalSession)/snapshot",
      "/api/agentflow/agent-sessions/\(canonicalSession)/events?after_sequence=0&limit=1",
    ]
    for path in canonicalReads {
      let read = try performRead(path).get()
      guard read.status == 200, read.body == "{\"read\":true}" else { throw VerificationFailure.failed("canonical read policy") }
    }
    let readCancelStarted = Date()
    guard case .failure = try performRead("/api/agentflow/me/agent-events?after_sequence=7&limit=1", cancelAfter: 0.1),
      Date().timeIntervalSince(readCancelStarted) < 2 else { throw VerificationFailure.failed("read cancel did not interrupt") }

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
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "GET", htu: dpopHtu + "?x=1", accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("unsafe DPoP htu accepted")
    } catch DeviceKeyFailure.invalid {}
    do {
      _ = try DpopProof.signingInput(origin: dpopOrigin, method: "POST", htu: dpopHtu, accessToken: "access.safe.jwt", x: x, y: y, nowSeconds: 1, jti: dpopJti)
      throw VerificationFailure.failed("unlisted DPoP method accepted")
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
