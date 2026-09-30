package expo.modules.xgennativedevice

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class DeviceProofTest {
  @Test fun p256DerConversionPreservesRealSignaturesAndJwtClaims() {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val challenge = DeviceProof.encode(ByteArray(32) { 5 })
    for (purpose in listOf("register", "approval_request", "login", "native_refresh")) {
      val input = DeviceProof.signingInput(purpose, challenge, 1700000000)
      val payload = String(Base64.getUrlDecoder().decode(input.split('.')[1]))
      assertEquals("{\"challenge\":\"$challenge\",\"purpose\":\"$purpose\",\"iat\":1700000000}", payload)
      repeat(100) {
        val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(input.toByteArray()); sign() }
        val raw = DeviceProof.rawSignature(der)
        assertEquals(64, raw.size)
        val verified = Signature.getInstance("SHA256withECDSAinP1363Format").run { initVerify(pair.public); update(input.toByteArray()); verify(raw) }
        assertTrue(verified)
      }
    }
  }
  @Test fun scopesMatchSwiftAndRejectUnsafeOriginsAndIdentifiers() {
    assertEquals("4e88a9fc13244fdc59395b7125e91d15509ad90a922ed5917c1103a15d097b6c", DeviceProof.scope("https://xgen.example.test", "7"))
    for (origin in listOf("http://localhost", "https://user:pass@xgen.example.test", "https://xgen.example.test/path", "https://xgen.example.test?q=1")) assertThrows(IllegalArgumentException::class.java) { DeviceProof.scope(origin, "7") }
    assertThrows(IllegalArgumentException::class.java) { DeviceProof.scope("https://xgen.example.test", "0") }
    assertNotEquals(DeviceProof.scope("https://xgen.example.test", "7"), DeviceProof.scope("https://other.test", "7"))
    assertNotEquals(DeviceProof.scope("https://xgen.example.test", "7"), DeviceProof.scope("https://xgen.example.test", "8"))
  }
  @Test fun rejectsMalformedDerAndCeremonies() {
    for (der in listOf(byteArrayOf(), byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01), byteArrayOf(0x30, 0x06, 0x02, 0x01, 0xff.toByte(), 0x02, 0x01, 0x01))) assertThrows(IllegalArgumentException::class.java) { DeviceProof.rawSignature(der) }
    assertThrows(IllegalArgumentException::class.java) { DeviceProof.signingInput("unknown", DeviceProof.encode(ByteArray(32)), 1) }
    assertThrows(IllegalArgumentException::class.java) { DeviceProof.signingInput("register", "invalid", 1) }
  }
}
