package expo.modules.xgennativedevice

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class XgenNativeDeviceModule : Module() {
  private val transport = NativeEnrollmentTransport.production()
  private val agentSockets = NativeAgentSocket.production()
  private fun <T> safe(work: (HardwareDeviceKey) -> T): T = try {
    work(HardwareDeviceKey(appContext.reactContext ?: throw DeviceKeyFailure("mobile_key_unavailable")))
  } catch (error: DeviceKeyFailure) { throw CodedException(error.code, "Mobile device key unavailable", null) }
    catch (_: Exception) { throw CodedException("mobile_key_unavailable", "Mobile device key unavailable", null) }
  override fun definition() = ModuleDefinition {
    Name("XgenNativeDevice")
    Function("newRequestId") {
      try { transport.newRequestId() }
      catch (error: MobileTransportFailure) { throw CodedException(error.code, "Mobile transport unavailable", null) }
      catch (_: Exception) { throw CodedException("mobile_transport_unavailable", "Mobile transport unavailable", null) }
    }
    Function("newGeneration") { UUID.randomUUID().toString() }
    Function("newTurnKey") { UUID.randomUUID().toString() }
    Function("newSocketId") {
      try { agentSockets.newSocketId() }
      catch (error: MobileSocketFailure) { throw CodedException(error.code, "Mobile socket unavailable", null) }
      catch (_: Exception) { throw CodedException("mobile_socket_unavailable", "Mobile socket unavailable", null) }
    }
    AsyncFunction("prepare") { origin: String, userId: String, create: Boolean -> safe { it.prepare(origin, userId, create) } }
    AsyncFunction("signChallenge") { origin: String, userId: String, installId: String, thumbprint: String, purpose: String, challenge: String ->
      safe { it.sign(origin, userId, installId, thumbprint, purpose, challenge) }
    }
    AsyncFunction("signDpop") { origin: String, userId: String, installId: String, thumbprint: String, method: String, htu: String, accessToken: String ->
      safe { it.signDpop(origin, userId, installId, thumbprint, method, htu, accessToken) }
    }
    AsyncFunction("request") { requestId: String, origin: String, path: String, method: String, accessToken: String, body: String?, promise: Promise ->
      try {
        transport.request(requestId, origin, path, method, accessToken, body) { result ->
          result.fold(
            onSuccess = { promise.resolve(mapOf("status" to it.status, "body" to it.body)) },
            onFailure = { promise.reject((it as? MobileTransportFailure)?.code ?: "mobile_transport_unavailable", "Mobile transport unavailable", null) }
          )
        }
      } catch (error: MobileTransportFailure) {
        promise.reject(error.code, "Mobile transport unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable", null)
      }
    }
    AsyncFunction("sessionRequest") { requestId: String, origin: String, path: String, method: String, authorization: String?, dpop: String?, body: String?, promise: Promise ->
      try {
        transport.sessionRequest(requestId, origin, path, method, authorization, dpop, body) { result ->
          result.fold(
            onSuccess = { promise.resolve(mapOf("status" to it.status, "body" to it.body)) },
            onFailure = { promise.reject((it as? MobileTransportFailure)?.code ?: "mobile_transport_unavailable", "Mobile transport unavailable", null) }
          )
        }
      } catch (error: MobileTransportFailure) {
        promise.reject(error.code, "Mobile transport unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable", null)
      }
    }
    AsyncFunction("readRequest") { requestId: String, origin: String, pathWithQuery: String, accessToken: String, dpop: String, promise: Promise ->
      try {
        transport.readRequest(requestId, origin, pathWithQuery, accessToken, dpop) { result ->
          result.fold(
            onSuccess = { promise.resolve(mapOf("status" to it.status, "body" to it.body)) },
            onFailure = { promise.reject((it as? MobileTransportFailure)?.code ?: "mobile_transport_unavailable", "Mobile transport unavailable", null) }
          )
        }
      } catch (error: MobileTransportFailure) {
        promise.reject(error.code, "Mobile transport unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable", null)
      }
    }
    AsyncFunction("turnRequest") { requestId: String, origin: String, path: String, accessToken: String, dpop: String, body: String, promise: Promise ->
      try {
        transport.turnRequest(requestId, origin, path, accessToken, dpop, body) { result ->
          result.fold(
            onSuccess = { promise.resolve(mapOf("status" to it.status, "body" to it.body)) },
            onFailure = { promise.reject((it as? MobileTransportFailure)?.code ?: "mobile_transport_unavailable", "Mobile transport unavailable", null) }
          )
        }
      } catch (error: MobileTransportFailure) {
        promise.reject(error.code, "Mobile transport unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable", null)
      }
    }
    AsyncFunction("lifecycleRequest") { requestId: String, origin: String, path: String, method: String, accessToken: String, dpop: String, body: String, promise: Promise ->
      try {
        transport.lifecycleRequest(requestId, origin, path, method, accessToken, dpop, body) { result ->
          result.fold(
            onSuccess = { promise.resolve(mapOf("status" to it.status, "body" to it.body)) },
            onFailure = { promise.reject((it as? MobileTransportFailure)?.code ?: "mobile_transport_unavailable", "Mobile transport unavailable", null) }
          )
        }
      } catch (error: MobileTransportFailure) {
        promise.reject(error.code, "Mobile transport unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_transport_unavailable", "Mobile transport unavailable", null)
      }
    }
    AsyncFunction("cancelRequest") { requestId: String ->
      try { transport.cancelRequest(requestId) }
      catch (error: MobileTransportFailure) { throw CodedException(error.code, "Mobile transport unavailable", null) }
      catch (_: Exception) { throw CodedException("mobile_transport_unavailable", "Mobile transport unavailable", null) }
    }
    AsyncFunction("openAgentSocket") { socketId: String, origin: String, sessionId: String, afterSequence: String, accessToken: String, dpop: String, promise: Promise ->
      try {
        agentSockets.open(socketId, origin, sessionId, afterSequence, accessToken, dpop) { result ->
          result.fold(
            onSuccess = { promise.resolve(null) },
            onFailure = { promise.reject((it as? MobileSocketFailure)?.code ?: "mobile_socket_unavailable", "Mobile socket unavailable", null) }
          )
        }
      } catch (error: MobileSocketFailure) {
        promise.reject(error.code, "Mobile socket unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable", null)
      }
    }
    AsyncFunction("nextAgentSocket") { socketId: String, promise: Promise ->
      try {
        agentSockets.next(socketId) { result ->
          result.fold(
            onSuccess = { promise.resolve(it) },
            onFailure = { promise.reject((it as? MobileSocketFailure)?.code ?: "mobile_socket_unavailable", "Mobile socket unavailable", null) }
          )
        }
      } catch (error: MobileSocketFailure) {
        promise.reject(error.code, "Mobile socket unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable", null)
      }
    }
    AsyncFunction("closeAgentSocket") { socketId: String, promise: Promise ->
      try {
        agentSockets.close(socketId) { result ->
          result.fold(
            onSuccess = { promise.resolve(null) },
            onFailure = { promise.reject((it as? MobileSocketFailure)?.code ?: "mobile_socket_unavailable", "Mobile socket unavailable", null) }
          )
        }
      } catch (error: MobileSocketFailure) {
        promise.reject(error.code, "Mobile socket unavailable", null)
      } catch (_: Exception) {
        promise.reject("mobile_socket_unavailable", "Mobile socket unavailable", null)
      }
    }
    OnDestroy {
      transport.cancelAll()
      agentSockets.closeAll()
    }
  }
}
