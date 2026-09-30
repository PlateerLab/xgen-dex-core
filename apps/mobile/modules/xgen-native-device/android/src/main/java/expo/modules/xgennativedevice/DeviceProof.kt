package expo.modules.xgennativedevice

import java.net.URI
import java.security.MessageDigest
import java.util.Base64

// No Android API dependencies: the same codec is tested with JCA P-256 signatures.
internal object DeviceProof {
  private val purposes = setOf("register", "approval_request", "login", "native_refresh")
  fun scope(origin: String, userId: String): String {
    val url = URI(origin)
    require(url.scheme == "https" && url.host != null && url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null)
    require(url.rawPath.isNullOrEmpty() && url.toASCIIString() == origin)
    require(userId.matches(Regex("[1-9][0-9]{0,18}")))
    return MessageDigest.getInstance("SHA-256").digest("mobile\n$origin\n$userId".toByteArray()).joinToString("") { "%02x".format(it) }
  }
  fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
  fun thumbprint(x: String, y: String): String = encode(MessageDigest.getInstance("SHA-256")
    .digest("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"$x\",\"y\":\"$y\"}".toByteArray()))
  fun signingInput(purpose: String, challenge: String, nowSeconds: Long): String {
    require(purpose in purposes && challenge.matches(Regex("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]")))
    val header = encode("{\"alg\":\"ES256\",\"typ\":\"platform-device-proof+jwt\"}".toByteArray())
    val claims = encode("{\"challenge\":\"$challenge\",\"purpose\":\"$purpose\",\"iat\":$nowSeconds}".toByteArray())
    return "$header.$claims"
  }
  fun rawSignature(der: ByteArray): ByteArray {
    // P-256 DER sequences are short-form lengths only. Reject noncanonical integers.
    var cursor = 0
    fun next(): Int { require(cursor < der.size); return der[cursor++].toInt() and 255 }
    require(next() == 0x30 && next() == der.size - 2)
    fun integer(): ByteArray {
      require(next() == 0x02)
      val length = next(); require(length in 1..33 && cursor + length <= der.size)
      val value = der.copyOfRange(cursor, cursor + length); cursor += length
      require((value[0].toInt() and 128) == 0)
      val start = if (length > 1 && value[0] == 0.toByte()) { require((value[1].toInt() and 128) != 0); 1 } else 0
      require(length - start <= 32 && value.any { it != 0.toByte() })
      return ByteArray(32).also { value.copyInto(it, 32 - length + start, start) }
    }
    val r = integer(); val s = integer(); require(cursor == der.size)
    return r + s
  }
}
