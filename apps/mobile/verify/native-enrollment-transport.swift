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

    print("native enrollment/session URLSession and DPoP verification passed")
  }
}
