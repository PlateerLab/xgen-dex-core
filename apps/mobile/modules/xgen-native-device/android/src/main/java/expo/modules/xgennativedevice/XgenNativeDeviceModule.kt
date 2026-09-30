package expo.modules.xgennativedevice

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class XgenNativeDeviceModule : Module() {
  private fun <T> safe(work: (HardwareDeviceKey) -> T): T = try {
    work(HardwareDeviceKey(appContext.reactContext ?: throw DeviceKeyFailure("mobile_key_unavailable")))
  } catch (error: DeviceKeyFailure) { throw CodedException(error.code, "Mobile device key unavailable", null) }
    catch (_: Exception) { throw CodedException("mobile_key_unavailable", "Mobile device key unavailable", null) }
  override fun definition() = ModuleDefinition {
    Name("XgenNativeDevice")
    AsyncFunction("prepare") { origin: String, userId: String, create: Boolean -> safe { it.prepare(origin, userId, create) } }
    AsyncFunction("signChallenge") { origin: String, userId: String, installId: String, thumbprint: String, purpose: String, challenge: String ->
      safe { it.sign(origin, userId, installId, thumbprint, purpose, challenge) }
    }
  }
}
