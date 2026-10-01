package expo.modules.xgennativedevice

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class DpopProofTest {
  private fun coordinate(bytes: ByteArray): String {
    val value = bytes.dropWhile { it == 0.toByte() }.toByteArray()
    return DeviceProof.encode(ByteArray(32).also { value.copyInto(it, 32 - value.size) })
  }

  @Test fun createsVerifiableP256ProofWithBoundClaimsAndPublicJwk() {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val public = pair.public as ECPublicKey
    val x = coordinate(public.w.affineX.toByteArray())
    val y = coordinate(public.w.affineY.toByteArray())
    val token = "access.token.safe"
    val origin = "https://xgen.example.test"
    val htu = "$origin/api/me/platform-sessions/00000000-0000-4000-8000-000000000001"
    val jti = "abcdefab-cdef-4abc-8def-abcdefabcdef"
    val jwt = DpopProof.create(origin, "DELETE", htu, token, x, y, 1_700_000_000, jti) { input ->
      val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(input); sign() }
      DeviceProof.rawSignature(der)
    }
    val parts = jwt.split('.')
    assertEquals(3, parts.size)
    assertEquals("{\"typ\":\"dpop+jwt\",\"alg\":\"ES256\",\"jwk\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"$x\",\"y\":\"$y\"}}", String(Base64.getUrlDecoder().decode(parts[0])))
    val ath = DeviceProof.encode(MessageDigest.getInstance("SHA-256").digest(token.toByteArray()))
    assertEquals("{\"htm\":\"DELETE\",\"htu\":\"$htu\",\"iat\":1700000000,\"jti\":\"$jti\",\"ath\":\"$ath\"}", String(Base64.getUrlDecoder().decode(parts[1])))
    assertTrue(Signature.getInstance("SHA256withECDSAinP1363Format").run {
      initVerify(pair.public); update("${parts[0]}.${parts[1]}".toByteArray()); verify(Base64.getUrlDecoder().decode(parts[2]))
    })
    assertTrue(jwt.length <= 8_192)
  }

  @Test fun acceptsOnlyCanonicalAllowlistedHtuAndSafeInputs() {
    val x = DeviceProof.encode(ByteArray(32) { 1 })
    val y = DeviceProof.encode(ByteArray(32) { 2 })
    val origin = "https://xgen.example.test"
    val jti = "abcdefab-cdef-4abc-8def-abcdefabcdef"
    val paths = listOf(
      "/api/agentflow/me/agent-state", "/api/agentflow/me/agent-events", "/api/agentflow/me/agent-sessions",
      "/api/agentflow/agent-sessions/00000000-0000-4000-8000-000000000001/snapshot",
      "/api/agentflow/agent-sessions/00000000-0000-4000-8000-000000000001/events",
      "/api/agentflow/agent-sessions/00000000-0000-4000-8000-000000000001/messages"
    )
    paths.forEach { assertTrue(DpopProof.signingInput(origin, "GET", origin + it, "safe.jwt.token", x, y, 1, jti).contains('.')) }
    fun invalid(originValue: String = origin, method: String = "GET", htu: String = "$origin/api/agentflow/me/agent-state", token: String = "safe.jwt.token", id: String = jti) {
      assertThrows(IllegalArgumentException::class.java) { DpopProof.signingInput(originValue, method, htu, token, x, y, 1, id) }
    }
    invalid(originValue = "http://xgen.example.test", htu = "http://xgen.example.test/api/agentflow/me/agent-state")
    invalid(method = "POST")
    invalid(htu = "$origin/api/agentflow/me/agent-state?x=1")
    invalid(htu = "$origin/api/agentflow/agent-sessions/00000000-0000-4000-8000-000000000001/messages?after_sequence=0&limit=20")
    invalid(htu = "${origin}evil/api/agentflow/me/agent-state")
    invalid(token = "opaque-safe-token")
    invalid(id = jti.uppercase())
  }
}
