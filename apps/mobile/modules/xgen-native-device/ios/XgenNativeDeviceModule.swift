import ExpoModulesCore
import Foundation

public final class XgenNativeDeviceModule: Module {
  private let keys = HardwareDeviceKey()
  private let transport = NativeEnrollmentTransport()
  private let agentSocket = NativeAgentSocket()
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
    Function("newRequestId") {
      do { return try self.transport.newRequestId() }
      catch let error as MobileTransportFailure {
        throw Exception(name: "MobileTransport", description: "Mobile transport unavailable", code: error.code)
      }
      catch { throw Exception(name: "MobileTransport", description: "Mobile transport unavailable", code: "mobile_transport_unavailable") }
    }
    Function("newGeneration") { UUID().uuidString.lowercased() }
    Function("newTurnKey") { UUID().uuidString.lowercased() }
    Function("newSocketId") {
      do { return try self.agentSocket.newSocketId() }
      catch let error as NativeSocketFailure {
        throw Exception(name: "MobileSocket", description: "Mobile socket unavailable", code: error.code)
      }
      catch { throw Exception(name: "MobileSocket", description: "Mobile socket unavailable", code: "mobile_socket_unavailable") }
    }
    AsyncFunction("prepare") { (origin: String, userId: String, create: Bool) in
      try self.safe { try self.keys.prepare(origin, userId, create) }
    }
    AsyncFunction("signChallenge") { (origin: String, userId: String, installId: String, thumbprint: String, purpose: String, challenge: String) in
      try self.safe { try self.keys.sign(origin, userId, installId, thumbprint, purpose, challenge) }
    }
    AsyncFunction("signDpop") { (origin: String, userId: String, installId: String, thumbprint: String, method: String, htu: String, accessToken: String) in
      try self.safe { try self.keys.signDpop(origin, userId, installId, thumbprint, method, htu, accessToken) }
    }
    AsyncFunction("request") { (requestId: String, origin: String, path: String, method: String, accessToken: String, body: String?, promise: Promise) in
      do {
        try self.transport.request(requestId: requestId, origin: origin, path: path, method: method, accessToken: accessToken, body: body) { result in
          switch result {
          case .success(let response): promise.resolve(["status": response.status, "body": response.body])
          case .failure(let error): promise.reject(error.code, "Mobile transport unavailable")
          }
        }
      } catch let error as MobileTransportFailure {
        promise.reject(error.code, "Mobile transport unavailable")
      } catch {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable")
      }
    }
    AsyncFunction("sessionRequest") { (requestId: String, origin: String, path: String, method: String, authorization: String?, dpop: String?, body: String?, promise: Promise) in
      do {
        try self.transport.sessionRequest(requestId: requestId, origin: origin, path: path, method: method, authorization: authorization, dpop: dpop, body: body) { result in
          switch result {
          case .success(let response): promise.resolve(["status": response.status, "body": response.body])
          case .failure(let error): promise.reject(error.code, "Mobile transport unavailable")
          }
        }
      } catch let error as MobileTransportFailure {
        promise.reject(error.code, "Mobile transport unavailable")
      } catch {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable")
      }
    }
    AsyncFunction("readRequest") { (requestId: String, origin: String, pathWithQuery: String, accessToken: String, dpop: String, promise: Promise) in
      do {
        try self.transport.readRequest(requestId: requestId, origin: origin, pathWithQuery: pathWithQuery, accessToken: accessToken, dpop: dpop) { result in
          switch result {
          case .success(let response): promise.resolve(["status": response.status, "body": response.body])
          case .failure(let error): promise.reject(error.code, "Mobile transport unavailable")
          }
        }
      } catch let error as MobileTransportFailure {
        promise.reject(error.code, "Mobile transport unavailable")
      } catch {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable")
      }
    }
    AsyncFunction("turnRequest") { (requestId: String, origin: String, path: String, accessToken: String, dpop: String, body: String, promise: Promise) in
      do {
        try self.transport.turnRequest(requestId: requestId, origin: origin, path: path, accessToken: accessToken, dpop: dpop, body: body) { result in
          switch result {
          case .success(let response): promise.resolve(["status": response.status, "body": response.body])
          case .failure(let error): promise.reject(error.code, "Mobile transport unavailable")
          }
        }
      } catch let error as MobileTransportFailure {
        promise.reject(error.code, "Mobile transport unavailable")
      } catch {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable")
      }
    }
    AsyncFunction("lifecycleRequest") { (requestId: String, origin: String, path: String, method: String, accessToken: String, dpop: String, body: String, promise: Promise) in
      do {
        try self.transport.lifecycleRequest(requestId: requestId, origin: origin, path: path, method: method,
          accessToken: accessToken, dpop: dpop, body: body) { result in
          switch result {
          case .success(let response): promise.resolve(["status": response.status, "body": response.body])
          case .failure(let error): promise.reject(error.code, "Mobile transport unavailable")
          }
        }
      } catch let error as MobileTransportFailure {
        promise.reject(error.code, "Mobile transport unavailable")
      } catch {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable")
      }
    }
    AsyncFunction("cancelRequest") { (requestId: String) in
      do { try self.transport.cancelRequest(requestId) }
      catch let error as MobileTransportFailure {
        throw Exception(name: "MobileTransport", description: "Mobile transport unavailable", code: error.code)
      }
      catch { throw Exception(name: "MobileTransport", description: "Mobile transport unavailable", code: "mobile_transport_unavailable") }
    }
    AsyncFunction("openAgentSocket") { (socketId: String, origin: String, sessionId: String, afterSequence: String, accessToken: String, dpop: String, promise: Promise) in
      do {
        try self.agentSocket.openAgentSocket(socketId: socketId, origin: origin, sessionId: sessionId,
          afterSequence: afterSequence, accessToken: accessToken, dpop: dpop) { result in
          switch result {
          case .success: promise.resolve(nil)
          case .failure(let error): promise.reject(error.code, "Mobile socket unavailable")
          }
        }
      } catch let error as NativeSocketFailure {
        promise.reject(error.code, "Mobile socket unavailable")
      } catch {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable")
      }
    }
    AsyncFunction("nextAgentSocket") { (socketId: String, promise: Promise) in
      do {
        try self.agentSocket.nextAgentSocket(socketId: socketId) { result in
          switch result {
          case .success(let event): promise.resolve(["type": event.type, "text": event.text])
          case .failure(let error): promise.reject(error.code, "Mobile socket unavailable")
          }
        }
      } catch let error as NativeSocketFailure {
        promise.reject(error.code, "Mobile socket unavailable")
      } catch {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable")
      }
    }
    AsyncFunction("closeAgentSocket") { (socketId: String, promise: Promise) in
      do {
        try self.agentSocket.closeAgentSocket(socketId: socketId) { result in
          switch result {
          case .success: promise.resolve(nil)
          case .failure(let error): promise.reject(error.code, "Mobile socket unavailable")
          }
        }
      } catch let error as NativeSocketFailure {
        promise.reject(error.code, "Mobile socket unavailable")
      } catch {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable")
      }
    }
    OnDestroy {
      self.transport.cancelAll()
      self.agentSocket.closeAll()
    }
  }
}
