import Foundation
import CryptoKit

enum DeviceKeyFailure: Error { case unavailable, locked, missing, invalid }
enum DeviceProof {
  static func scope(_ origin: String, _ userId: String) throws -> String {
    guard let url = URLComponents(string: origin), url.scheme == "https", url.host != nil,
      url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
      url.url?.absoluteString == origin,
      userId.range(of: "^[1-9][0-9]{0,18}$", options: .regularExpression) != nil else { throw DeviceKeyFailure.invalid }
    return SHA256.hash(data: Data("mobile\n\(origin)\n\(userId)".utf8)).map { String(format: "%02x", $0) }.joined()
  }
  static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  static func thumbprint(_ x: String, _ y: String) -> String {
    encode(Data(SHA256.hash(data: Data("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}".utf8))))
  }
  static func signingInput(_ purpose: String, _ challenge: String, _ now: Int64) throws -> String {
    guard ["register", "approval_request", "login", "native_refresh"].contains(purpose),
      challenge.range(of: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$", options: .regularExpression) != nil else { throw DeviceKeyFailure.invalid }
    let header = encode(Data("{\"alg\":\"ES256\",\"typ\":\"platform-device-proof+jwt\"}".utf8))
    let claims = encode(Data("{\"challenge\":\"\(challenge)\",\"purpose\":\"\(purpose)\",\"iat\":\(now)}".utf8))
    return "\(header).\(claims)"
  }
  static func rawSignature(_ der: Data) throws -> Data {
    let bytes = [UInt8](der); var cursor = 0
    func next() throws -> Int {
      guard cursor < bytes.count else { throw DeviceKeyFailure.invalid }; defer { cursor += 1 }; return Int(bytes[cursor])
    }
    guard try next() == 0x30, try next() == bytes.count - 2 else { throw DeviceKeyFailure.invalid }
    func integer() throws -> [UInt8] {
      guard try next() == 0x02 else { throw DeviceKeyFailure.invalid }
      let length = try next()
      guard (1...33).contains(length), cursor + length <= bytes.count else { throw DeviceKeyFailure.invalid }
      var value = Array(bytes[cursor..<(cursor + length)]); cursor += length
      guard value[0] & 0x80 == 0 else { throw DeviceKeyFailure.invalid }
      if length > 1 && value[0] == 0 {
        guard value[1] & 0x80 != 0 else { throw DeviceKeyFailure.invalid }; value.removeFirst()
      }
      guard value.count <= 32, value.contains(where: { $0 != 0 }) else { throw DeviceKeyFailure.invalid }
      return Array(repeating: 0, count: 32 - value.count) + value
    }
    let r = try integer(); let s = try integer()
    guard cursor == bytes.count else { throw DeviceKeyFailure.invalid }
    return Data(r + s)
  }
}

/** Platform-independent codec. Production supplies only a hardware-backed signing closure. */
enum DpopProof {
  private static let maximumJWTLength = 8_192
  private static let jwt = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
  private static let coordinate = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{43}$")
  private static let sessionIdPath = try! NSRegularExpression(pattern: "^/api/me/platform-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
  private static let agentSessionPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(snapshot|events|messages)$")
  private static let agentSessionTurnPath = try! NSRegularExpression(pattern: "^/api/agentflow/agent-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(turns|stop)$")

  private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
    let fullRange = NSRange(value.startIndex..., in: value)
    return expression.firstMatch(in: value, range: fullRange)?.range == fullRange
  }

  private static func canonicalOrigin(_ origin: String) -> Bool {
    guard let components = URLComponents(string: origin) else { return false }
    return components.scheme == "https" && components.host != nil && components.user == nil && components.password == nil &&
      components.path.isEmpty && components.query == nil && components.fragment == nil && components.url?.absoluteString == origin
  }

  private static func allowed(_ method: String, _ path: String) -> Bool {
    switch method {
    case "DELETE": return matches(sessionIdPath, path)
    case "POST": return path == "/api/agentflow/agent-sessions" || matches(agentSessionTurnPath, path)
    case "PUT": return path == "/api/agentflow/me/agent-state"
    case "GET":
      return path == "/api/agentflow/me/agent-state" || path == "/api/agentflow/me/agent-events" ||
        path == "/api/agentflow/me/agent-sessions" || matches(agentSessionPath, path)
    default: return false
    }
  }

  static func signingInput(origin: String, method: String, htu: String, accessToken: String, x: String, y: String, nowSeconds: Int64, jti: String) throws -> String {
    guard canonicalOrigin(origin), accessToken.utf8.count <= maximumJWTLength, matches(jwt, accessToken), matches(coordinate, x), matches(coordinate, y), nowSeconds > 0,
      UUID(uuidString: jti)?.uuidString.lowercased() == jti, htu.hasPrefix(origin) else { throw DeviceKeyFailure.invalid }
    let path = String(htu.dropFirst(origin.count))
    guard htu == origin + path, allowed(method, path), !path.contains("%"), !path.contains("?"),
      !path.contains("#"), !path.contains("\\") else { throw DeviceKeyFailure.invalid }
    let ath = DeviceProof.encode(Data(SHA256.hash(data: Data(accessToken.utf8))))
    let header = DeviceProof.encode(Data("{\"typ\":\"dpop+jwt\",\"alg\":\"ES256\",\"jwk\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"\(x)\",\"y\":\"\(y)\"}}".utf8))
    let claims = DeviceProof.encode(Data("{\"htm\":\"\(method)\",\"htu\":\"\(htu)\",\"iat\":\(nowSeconds),\"jti\":\"\(jti)\",\"ath\":\"\(ath)\"}".utf8))
    let input = "\(header).\(claims)"
    guard input.utf8.count + 87 <= maximumJWTLength else { throw DeviceKeyFailure.invalid }
    return input
  }

  static func create(origin: String, method: String, htu: String, accessToken: String, x: String, y: String, nowSeconds: Int64, jti: String, signer: (Data) throws -> Data) throws -> String {
    let input = try signingInput(origin: origin, method: method, htu: htu, accessToken: accessToken, x: x, y: y, nowSeconds: nowSeconds, jti: jti)
    let raw = try signer(Data(input.utf8))
    guard raw.count == 64 else { throw DeviceKeyFailure.invalid }
    let jwt = "\(input).\(DeviceProof.encode(raw))"
    guard jwt.utf8.count <= maximumJWTLength else { throw DeviceKeyFailure.invalid }
    return jwt
  }
}
