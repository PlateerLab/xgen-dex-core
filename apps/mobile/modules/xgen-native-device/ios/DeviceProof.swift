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
