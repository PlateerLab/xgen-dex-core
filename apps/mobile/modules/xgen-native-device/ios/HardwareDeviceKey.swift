import Foundation
import Security
import LocalAuthentication

final class HardwareDeviceKey {
  private static let lock = NSLock()
  private let service = "com.plateerlab.xgendex.native.identity.v1"
  private func noInteraction() -> LAContext { let context = LAContext(); context.interactionNotAllowed = true; return context }
  private func keyQuery(_ scope: String) -> [String: Any] {
    [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: Data("xgen-mobile-v1-\(scope)".utf8),
     kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
     kSecUseAuthenticationContext as String: noInteraction()]
  }
  private func metadataQuery(_ scope: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: scope,
     kSecAttrSynchronizable as String: false, kSecUseAuthenticationContext as String: noInteraction()]
  }
  private func checked(_ status: OSStatus) throws {
    if status == errSecInteractionNotAllowed { throw DeviceKeyFailure.locked }
    guard status == errSecSuccess else { throw DeviceKeyFailure.unavailable }
  }
  private func loadKey(_ scope: String) throws -> SecKey? {
    var query = keyQuery(scope); query[kSecReturnRef as String] = true
    var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }; try checked(status)
    guard let found = result, CFGetTypeID(found) == SecKeyGetTypeID() else { throw DeviceKeyFailure.invalid }
    return (found as! SecKey)
  }
  private func loadId(_ scope: String) throws -> String? {
    var query = metadataQuery(scope); query[kSecReturnData as String] = true
    var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }; try checked(status)
    guard let data = result as? Data, let id = String(data: data, encoding: .utf8), UUID(uuidString: id) != nil else { throw DeviceKeyFailure.invalid }
    return id
  }
  private func hardware(_ key: SecKey) throws {
    guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
      attributes[kSecAttrTokenID as String] as? String == kSecAttrTokenIDSecureEnclave as String,
      (attributes[kSecAttrKeySizeInBits as String] as? Int) == 256 else { throw DeviceKeyFailure.unavailable }
  }
  private func identity(_ origin: String, _ userId: String, _ create: Bool) throws -> (SecKey, [String: Any]) {
    // Simulator has no Secure Enclave. Never create a software P-256 substitute.
    #if targetEnvironment(simulator)
    throw DeviceKeyFailure.unavailable
    #else
    let scope = try DeviceProof.scope(origin, userId)
    var key = try loadKey(scope); var installId = try loadId(scope)
    guard (key == nil) == (installId == nil) else { throw DeviceKeyFailure.invalid }
    if key == nil {
      guard create else { throw DeviceKeyFailure.missing }
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage], &error) else { throw DeviceKeyFailure.unavailable }
      let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256, kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: Data("xgen-mobile-v1-\(scope)".utf8), kSecAttrAccessControl as String: access]]
      guard let generated = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw DeviceKeyFailure.unavailable }
      do {
        try hardware(generated)
        let id = UUID().uuidString.lowercased()
        var metadata = metadataQuery(scope); metadata.removeValue(forKey: kSecUseAuthenticationContext as String)
        metadata[kSecAttrAccessible as String] = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        metadata[kSecValueData as String] = Data(id.utf8)
        try checked(SecItemAdd(metadata as CFDictionary, nil))
        guard try loadId(scope) == id else { throw DeviceKeyFailure.unavailable }
        key = generated; installId = id
      } catch {
        // Only newly generated objects are removed; orphaned existing keys need explicit recovery.
        SecItemDelete(keyQuery(scope) as CFDictionary); SecItemDelete(metadataQuery(scope) as CFDictionary)
        throw error
      }
    }
    guard let actual = key, let id = installId else { throw DeviceKeyFailure.invalid }; try hardware(actual)
    guard let publicKey = SecKeyCopyPublicKey(actual),
      let bytes = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?, bytes.count == 65, bytes[0] == 4 else { throw DeviceKeyFailure.invalid }
    return (actual, ["installId": id, "storage": "secure-enclave", "publicKey": ["kty": "EC", "crv": "P-256",
      "x": DeviceProof.encode(bytes.subdata(in: 1..<33)), "y": DeviceProof.encode(bytes.subdata(in: 33..<65))]])
    #endif
  }
  func prepare(_ origin: String, _ userId: String, _ create: Bool) throws -> [String: Any] {
    Self.lock.lock(); defer { Self.lock.unlock() }
    return try identity(origin, userId, create).1
  }
  func sign(_ origin: String, _ userId: String, _ installId: String, _ thumbprint: String, _ purpose: String, _ challenge: String) throws -> String {
    Self.lock.lock(); defer { Self.lock.unlock() }
    let input = try DeviceProof.signingInput(purpose, challenge, Int64(Date().timeIntervalSince1970))
    let (key, metadata) = try identity(origin, userId, false)
    guard metadata["installId"] as? String == installId, let publicKey = metadata["publicKey"] as? [String: String],
      let x = publicKey["x"], let y = publicKey["y"], DeviceProof.thumbprint(x, y) == thumbprint else { throw DeviceKeyFailure.invalid }
    guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256),
      let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(input.utf8) as CFData, nil) as Data? else { throw DeviceKeyFailure.unavailable }
    return "\(input).\(DeviceProof.encode(try DeviceProof.rawSignature(signature)))"
  }
  func signDpop(_ origin: String, _ userId: String, _ installId: String, _ thumbprint: String, _ method: String, _ htu: String, _ accessToken: String) throws -> String {
    Self.lock.lock(); defer { Self.lock.unlock() }
    let (key, metadata) = try identity(origin, userId, false)
    guard metadata["installId"] as? String == installId, let publicKey = metadata["publicKey"] as? [String: String],
      let x = publicKey["x"], let y = publicKey["y"], DeviceProof.thumbprint(x, y) == thumbprint else { throw DeviceKeyFailure.invalid }
    guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256) else { throw DeviceKeyFailure.unavailable }
    return try DpopProof.create(origin: origin, method: method, htu: htu, accessToken: accessToken, x: x, y: y,
      nowSeconds: Int64(Date().timeIntervalSince1970), jti: UUID().uuidString.lowercased()) { input in
      guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, input as CFData, nil) as Data? else {
        throw DeviceKeyFailure.unavailable
      }
      return try DeviceProof.rawSignature(signature)
    }
  }
}
