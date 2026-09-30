import Foundation
import CryptoKit

@main struct NativeDeviceKeyCodecCheck {
  static func main() throws {
    let checkedScope = try DeviceProof.scope("https://xgen.example.test", "7")
    precondition(checkedScope == "4e88a9fc13244fdc59395b7125e91d15509ad90a922ed5917c1103a15d097b6c")
    precondition(DeviceProof.thumbprint("axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY", "T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU") == "xx0BcA-wMohw8atYDJOe6peGModklG2wRHBlXHMvl0M")
    for origin in ["http://localhost", "https://user:pass@xgen.example.test", "https://xgen.example.test/path", "https://xgen.example.test?q=1"] {
      do { _ = try DeviceProof.scope(origin, "7"); fatalError("unsafe scope accepted") } catch DeviceKeyFailure.invalid {}
    }
    let pair = P256.Signing.PrivateKey() // Test fixture only. Production uses SecKey Secure Enclave.
    let challenge = DeviceProof.encode(Data(repeating: 5, count: 32))
    for (purpose, value) in [("unknown", challenge), ("register", "invalid")] {
      do { _ = try DeviceProof.signingInput(purpose, value, 1); fatalError("invalid ceremony accepted") } catch DeviceKeyFailure.invalid {}
    }
    for purpose in ["register", "approval_request", "login", "native_refresh"] {
      let input = try DeviceProof.signingInput(purpose, challenge, 1700000000)
      for _ in 0..<100 {
        let der = try pair.signature(for: Data(input.utf8)).derRepresentation
        let raw = try DeviceProof.rawSignature(der)
        precondition(raw.count == 64)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: raw)
        precondition(pair.publicKey.isValidSignature(signature, for: Data(input.utf8)))
      }
    }
    for bytes: [UInt8] in [[], [0x30, 6, 2, 1, 0, 2, 1, 1], [0x30, 6, 2, 1, 0xff, 2, 1, 1]] {
      do { _ = try DeviceProof.rawSignature(Data(bytes)); fatalError("invalid DER accepted") } catch DeviceKeyFailure.invalid {}
    }
    print("Swift production codec: cross-platform scope/thumbprint, 400 real P-256 signatures, malformed DER, unsafe scope and ceremony PASS")
  }
}
