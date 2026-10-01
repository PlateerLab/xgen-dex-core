package expo.modules.xgennativedevice

import java.net.URI
import java.security.MessageDigest
import java.util.UUID

/** No Android API dependencies: tests exercise this codec with a software JCA P-256 key. */
internal object DpopProof {
  private const val MAX_JWT_LENGTH = 8_192
  private val jwt = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
  private val coordinate = Regex("[A-Za-z0-9_-]{43}")
  private val sessionIdPath = Regex("/api/me/platform-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
  private val agentSessionPath = Regex("/api/agentflow/agent-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(snapshot|events|messages)")

  private fun canonicalOrigin(origin: String): Boolean = try {
    val uri = URI(origin)
    uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null && uri.rawPath.isNullOrEmpty() &&
      uri.rawQuery == null && uri.rawFragment == null && uri.toASCIIString() == origin
  } catch (_: Exception) {
    false
  }

  private fun allowed(method: String, path: String): Boolean = when (method) {
    "DELETE" -> sessionIdPath.matches(path)
    "GET" -> path == "/api/agentflow/me/agent-state" ||
      path == "/api/agentflow/me/agent-events" ||
      path == "/api/agentflow/me/agent-sessions" || agentSessionPath.matches(path)
    else -> false
  }

  fun signingInput(
    origin: String,
    method: String,
    htu: String,
    accessToken: String,
    x: String,
    y: String,
    nowSeconds: Long,
    jti: String
  ): String {
    require(canonicalOrigin(origin) && accessToken.length <= MAX_JWT_LENGTH && jwt.matches(accessToken) && coordinate.matches(x) && coordinate.matches(y))
    require(UUID.fromString(jti).toString() == jti && nowSeconds > 0)
    val path = htu.removePrefix(origin)
    require(path != htu && allowed(method, path) && htu == origin + path)
    require(!path.contains('%') && !path.contains('?') && !path.contains('#') && !path.contains('\\'))
    val ath = DeviceProof.encode(MessageDigest.getInstance("SHA-256").digest(accessToken.toByteArray(Charsets.UTF_8)))
    val header = DeviceProof.encode("{\"typ\":\"dpop+jwt\",\"alg\":\"ES256\",\"jwk\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"$x\",\"y\":\"$y\"}}".toByteArray())
    val claims = DeviceProof.encode("{\"htm\":\"$method\",\"htu\":\"$htu\",\"iat\":$nowSeconds,\"jti\":\"$jti\",\"ath\":\"$ath\"}".toByteArray())
    return "$header.$claims".also { require(it.length + 1 + 86 <= MAX_JWT_LENGTH) }
  }

  fun create(
    origin: String,
    method: String,
    htu: String,
    accessToken: String,
    x: String,
    y: String,
    nowSeconds: Long,
    jti: String,
    signer: (ByteArray) -> ByteArray
  ): String {
    val input = signingInput(origin, method, htu, accessToken, x, y, nowSeconds, jti)
    val raw = signer(input.toByteArray(Charsets.UTF_8))
    require(raw.size == 64)
    return "$input.${DeviceProof.encode(raw)}".also { require(it.length <= MAX_JWT_LENGTH) }
  }
}
