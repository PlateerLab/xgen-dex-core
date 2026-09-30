package expo.modules.xgennativedevice

import android.app.KeyguardManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID

internal class DeviceKeyFailure(val code: String) : Exception("Mobile device key unavailable")
internal class HardwareDeviceKey(private val context: Context) {
  companion object { private val lock = Any() }
  private val store get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private val metadata get() = context.getSharedPreferences("xgen-native-device-public-v1", Context.MODE_PRIVATE)
  private fun unlocked() {
    if (Build.VERSION.SDK_INT < 28) throw DeviceKeyFailure("mobile_key_unavailable")
    val guard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (!guard.isDeviceSecure || guard.isDeviceLocked) throw DeviceKeyFailure("mobile_key_locked")
  }
  private fun hardware(entry: KeyStore.PrivateKeyEntry): String {
    val info = KeyFactory.getInstance(entry.privateKey.algorithm, "AndroidKeyStore").getKeySpec(entry.privateKey, KeyInfo::class.java)
    if (info.keySize != 256) throw DeviceKeyFailure("mobile_key_invalid")
    if (Build.VERSION.SDK_INT >= 31) return when (info.securityLevel) {
      KeyProperties.SECURITY_LEVEL_STRONGBOX -> "android-strongbox"
      KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "android-tee"
      else -> throw DeviceKeyFailure("mobile_key_unavailable")
    }
    @Suppress("DEPRECATION")
    if (!info.isInsideSecureHardware) throw DeviceKeyFailure("mobile_key_unavailable")
    return "android-tee"
  }
  private fun entry(alias: String): KeyStore.PrivateKeyEntry? = store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
  private fun generate(alias: String, strongBox: Boolean) {
    val options = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false)
      .setUnlockedDeviceRequired(true)
    if (strongBox) options.setIsStrongBoxBacked(true)
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(options.build()); generateKeyPair() }
  }
  fun prepare(origin: String, userId: String, create: Boolean): Map<String, Any> = synchronized(lock) {
    unlocked()
    val scope = DeviceProof.scope(origin, userId); val alias = "xgen-mobile-v1-$scope"
    var key = entry(alias); var installId = metadata.getString(scope, null)
    if ((key == null) != (installId == null)) throw DeviceKeyFailure("mobile_key_invalid")
    if (key == null) {
      if (!create) throw DeviceKeyFailure("mobile_key_missing")
      try {
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try { generate(alias, strongBox) } catch (error: StrongBoxUnavailableException) {
          // TEE remains hardware protection; no software provider fallback.
          store.deleteEntry(alias); generate(alias, false)
        }
        key = entry(alias) ?: throw DeviceKeyFailure("mobile_key_unavailable")
        hardware(key)
        installId = UUID.randomUUID().toString()
        if (!metadata.edit().putString(scope, installId).commit() || metadata.getString(scope, null) != installId) throw DeviceKeyFailure("mobile_key_unavailable")
      } catch (error: Exception) {
        // Remove only the entry created in this call, never repair an existing/orphaned key.
        store.deleteEntry(alias); metadata.edit().remove(scope).commit(); throw error
      }
    }
    val id = installId ?: throw DeviceKeyFailure("mobile_key_invalid")
    if (!id.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))) throw DeviceKeyFailure("mobile_key_invalid")
    val actual = key ?: throw DeviceKeyFailure("mobile_key_invalid")
    val public = actual.certificate.publicKey as? ECPublicKey ?: throw DeviceKeyFailure("mobile_key_invalid")
    fun coordinate(bytes: ByteArray): String {
      val value = bytes.dropWhile { it == 0.toByte() }.toByteArray(); require(value.size <= 32)
      return DeviceProof.encode(ByteArray(32).also { value.copyInto(it, 32 - value.size) })
    }
    unlocked()
    mapOf("installId" to id, "storage" to hardware(actual), "publicKey" to mapOf(
      "kty" to "EC", "crv" to "P-256", "x" to coordinate(public.w.affineX.toByteArray()), "y" to coordinate(public.w.affineY.toByteArray())))
  }
  fun sign(origin: String, userId: String, installId: String, thumbprint: String, purpose: String, challenge: String): String = synchronized(lock) {
    val input = DeviceProof.signingInput(purpose, challenge, System.currentTimeMillis() / 1000)
    val identity = prepare(origin, userId, false)
    val publicKey = identity["publicKey"] as Map<*, *>
    if (identity["installId"] != installId || DeviceProof.thumbprint(publicKey["x"] as String, publicKey["y"] as String) != thumbprint) throw DeviceKeyFailure("mobile_key_invalid")
    val key = entry("xgen-mobile-v1-${DeviceProof.scope(origin, userId)}") ?: throw DeviceKeyFailure("mobile_key_invalid")
    hardware(key); unlocked()
    val signature = Signature.getInstance("SHA256withECDSA").run { initSign(key.privateKey); update(input.toByteArray()); sign() }
    unlocked()
    return "$input.${DeviceProof.encode(DeviceProof.rawSignature(signature))}"
  }
}
