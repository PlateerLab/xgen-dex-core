import Foundation

private enum VerificationFailure: Error { case failed(String) }

@main
struct NativeEnrollmentTransportVerification {
  static func main() throws {
    guard CommandLine.arguments.count == 3 else { throw VerificationFailure.failed("expected HTTPS origin and fixture certificate") }
    let origin = CommandLine.arguments[1]
    let transport = NativeEnrollmentTransport(fixtureCertificate: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))

    func perform(_ path: String, method: String = "GET", body: String? = nil, cancelAfter: TimeInterval? = nil) throws -> Result<MobileTransportResponse, MobileTransportFailure> {
      let id = try transport.newRequestId()
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<MobileTransportResponse, MobileTransportFailure>?
      try transport.request(requestId: id, origin: origin, path: path, method: method, accessToken: "fixture-token_123~safe", body: body) {
        result = $0
        semaphore.signal()
      }
      if let cancelAfter {
        DispatchQueue.global().asyncAfter(deadline: .now() + cancelAfter) { try? transport.cancelRequest(id) }
      }
      guard semaphore.wait(timeout: .now() + 12) == .success, let result else { throw VerificationFailure.failed("request timeout") }
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

    let cancelledId = try transport.newRequestId()
    try transport.cancelRequest(cancelledId)
    do {
      try transport.request(requestId: cancelledId, origin: origin, path: "/api/auth/platform-devices/trust-overview", method: "GET", accessToken: "fixture-token_123~safe", body: nil) { _ in }
      throw VerificationFailure.failed("cancel-before-request opened")
    } catch MobileTransportFailure.unavailable {}

    print("native enrollment URLSession verification passed")
  }
}
