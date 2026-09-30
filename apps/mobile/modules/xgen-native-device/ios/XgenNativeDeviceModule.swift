import ExpoModulesCore

public final class XgenNativeDeviceModule: Module {
  private let keys = HardwareDeviceKey()
  private func safe<T>(_ work: () throws -> T) throws -> T {
    do { return try work() }
    catch {
      let code: String
      switch error {
      case DeviceKeyFailure.missing: code = "mobile_key_missing"
      case DeviceKeyFailure.invalid: code = "mobile_key_invalid"
      case DeviceKeyFailure.locked: code = "mobile_key_locked"
      default: code = "mobile_key_unavailable"
      }
      throw Exception(name: "MobileDeviceKey", description: "Mobile device key unavailable", code: code)
    }
  }
  public func definition() -> ModuleDefinition {
    Name("XgenNativeDevice")
    AsyncFunction("prepare") { (origin: String, userId: String, create: Bool) in
      try self.safe { try self.keys.prepare(origin, userId, create) }
    }
    AsyncFunction("signChallenge") { (origin: String, userId: String, installId: String, thumbprint: String, purpose: String, challenge: String) in
      try self.safe { try self.keys.sign(origin, userId, installId, thumbprint, purpose, challenge) }
    }
  }
}
