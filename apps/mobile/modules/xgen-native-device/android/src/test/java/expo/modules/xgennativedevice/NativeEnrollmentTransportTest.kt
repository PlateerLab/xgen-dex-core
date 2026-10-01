package expo.modules.xgennativedevice

import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher as MockDispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class NativeEnrollmentTransportTest {
  private lateinit var server: MockWebServer
  private lateinit var client: OkHttpClient
  private lateinit var origin: String

  @Before fun setUp() {
    val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    val serverCertificates = HandshakeCertificates.Builder().heldCertificate(certificate).build()
    val clientCertificates = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
    server = MockWebServer()
    server.useHttps(serverCertificates.sslSocketFactory(), false)
    server.start()
    origin = server.url("/").toString().removeSuffix("/")
    client = OkHttpClient.Builder()
      .sslSocketFactory(clientCertificates.sslSocketFactory(), clientCertificates.trustManager)
      .retryOnConnectionFailure(false)
      .followRedirects(false)
      .followSslRedirects(false)
      .cookieJar(CookieJar.NO_COOKIES)
      .authenticator(Authenticator.NONE)
      .proxyAuthenticator(Authenticator.NONE)
      .cache(null)
      .callTimeout(2, TimeUnit.SECONDS)
      .build()
  }

  @After fun tearDown() { server.shutdown() }

  private fun execute(path: String, method: String = "GET", body: String? = null): Result<MobileTransportResponse> {
    val result = AtomicReference<Result<MobileTransportResponse>>()
    val latch = CountDownLatch(1)
    val transport = NativeEnrollmentTransport(client)
    val reserved = transport.newRequestId()
    transport.request(reserved, origin, path, method, "token.safe-123", body) {
      result.set(it); latch.countDown()
    }
    assertTrue("request did not complete", latch.await(4, TimeUnit.SECONDS))
    return result.get()
  }

  @Test fun sendsOnlyFixedHeadersAndJsonOverFixtureTls() {
    server.enqueue(MockResponse().setResponseCode(201).setBody("{\"ok\":true}"))
    val result = execute("/api/auth/platform-devices/native/mobile/registration/challenge", "POST", "{\"nested\":[true,1,null,\"ok\"]}").getOrThrow()
    assertEquals(201, result.status)
    assertEquals("{\"ok\":true}", result.body)
    val request = server.takeRequest(1, TimeUnit.SECONDS)!!
    assertEquals("POST", request.method)
    assertEquals("application/json", request.getHeader("Accept"))
    assertEquals("application/json", request.getHeader("Content-Type"))
    assertEquals("Bearer token.safe-123", request.getHeader("Authorization"))
    assertEquals("{\"nested\":[true,1,null,\"ok\"]}", request.body.readUtf8())
  }

  @Test fun blocksUnsafeInputsBeforeOpeningAConnection() {
    val transport = NativeEnrollmentTransport(client)
    fun invalid(originValue: String = origin, path: String = "/api/auth/platform-devices/trust-overview", method: String = "GET", token: String = "safe", body: String? = null, id: String? = null) {
      val requestId = id ?: transport.newRequestId()
      val error = assertThrows(MobileTransportFailure::class.java) {
        transport.request(requestId, originValue, path, method, token, body) { fail("must not complete") }
      }
      assertEquals("mobile_transport_invalid", error.code)
    }
    invalid(originValue = origin.replace("https://", "http://"))
    invalid(originValue = "$origin/path")
    invalid(path = "/api/auth/platform-devices/native/mobile/registration/challenge%2f..", method = "POST", body = "{}")
    invalid(path = "/api/auth/platform-devices/trust-overview?x=1")
    invalid(method = "get")
    invalid(token = "safe\nunsafe")
    invalid(token = "unsafe+")
    invalid(body = "{}")
    invalid(method = "POST", path = "/api/auth/platform-devices/native/mobile/registration/challenge", body = "[]")
    invalid(method = "POST", path = "/api/auth/platform-devices/native/mobile/registration/challenge", body = "{'not':'json'}")
    invalid(method = "POST", path = "/api/auth/platform-devices/native/mobile/registration/challenge", body = "{\"x\":\"\\uD800\"}")
    invalid(id = UUID.randomUUID().toString().uppercase())
    assertEquals(0, server.requestCount)
  }

  @Test fun productionClientHasNoImplicitCredentialOrRetryMechanisms() {
    val transport = NativeEnrollmentTransport.production()
    val field = NativeEnrollmentTransport::class.java.getDeclaredField("client").apply { isAccessible = true }
    val configured = field.get(transport) as OkHttpClient
    assertFalse(configured.retryOnConnectionFailure)
    assertFalse(configured.followRedirects)
    assertFalse(configured.followSslRedirects)
    assertSame(CookieJar.NO_COOKIES, configured.cookieJar)
    assertSame(Authenticator.NONE, configured.authenticator)
    assertSame(Authenticator.NONE, configured.proxyAuthenticator)
    assertNull(configured.cache)
    assertTrue(configured.interceptors.isEmpty())
    assertTrue(configured.networkInterceptors.isEmpty())
    assertEquals(10_000, configured.callTimeoutMillis)
  }

  @Test fun rejectsRedirectWithoutFollowingAndDoesNotStoreCookiesOrAuthenticate() {
    server.dispatcher = object : MockDispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
        "/api/auth/platform-devices/native/mobile/registration/challenge" -> MockResponse().setResponseCode(200).addHeader("Set-Cookie", "secret=stored").setBody("{}")
        "/api/auth/platform-devices/native/mobile/registration/complete" -> {
          assertNull(request.getHeader("Cookie"))
          MockResponse().setResponseCode(401).addHeader("WWW-Authenticate", "Basic realm=test").setBody("denied")
        }
        "/api/auth/platform-devices/trust-overview" -> MockResponse().setResponseCode(302).addHeader("Location", "/escaped").setBody("redirect")
        else -> MockResponse().setResponseCode(500)
      }
    }
    assertTrue(execute("/api/auth/platform-devices/native/mobile/registration/challenge", "POST", "{}").isSuccess)
    val unauthorized = execute("/api/auth/platform-devices/native/mobile/registration/complete", "POST", "{}").getOrThrow()
    assertEquals(401, unauthorized.status)
    val redirect = execute("/api/auth/platform-devices/trust-overview")
    assertTrue(redirect.exceptionOrNull() is MobileTransportFailure)
    assertEquals(3, server.requestCount)
  }

  @Test fun capsStreamingResponseAndRequiresStrictUtf8() {
    server.enqueue(MockResponse().setChunkedBody("x".repeat(65_537), 1024))
    assertEquals("mobile_transport_unavailable", (execute("/api/auth/platform-devices/trust-overview").exceptionOrNull() as MobileTransportFailure).code)
    server.enqueue(MockResponse().setBody(Buffer().write(byteArrayOf(0xc3.toByte(), 0x28))))
    assertEquals("mobile_transport_unavailable", (execute("/api/auth/platform-devices/trust-overview").exceptionOrNull() as MobileTransportFailure).code)
  }

  @Test fun rejectsDuplicateActiveIdAndCancelInterruptsTheCall() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val transport = NativeEnrollmentTransport(client)
    val requestId = transport.newRequestId()
    val result = AtomicReference<Result<MobileTransportResponse>>()
    val latch = CountDownLatch(1)
    transport.request(requestId, origin, "/api/auth/platform-devices/trust-overview", "GET", "safe", null) {
      result.set(it); latch.countDown()
    }
    val duplicate = assertThrows(MobileTransportFailure::class.java) {
      transport.request(requestId, origin, "/api/auth/platform-devices/trust-overview", "GET", "safe", null) {}
    }
    assertEquals("mobile_transport_busy", duplicate.code)
    transport.cancelRequest(requestId)
    assertTrue(latch.await(2, TimeUnit.SECONDS))
    assertEquals("mobile_transport_unavailable", (result.get().exceptionOrNull() as MobileTransportFailure).code)
  }

  @Test fun cancelBeforeRequestPreventsAnyConnection() {
    val transport = NativeEnrollmentTransport(client)
    val requestId = transport.newRequestId()
    transport.cancelRequest(requestId)
    val error = assertThrows(MobileTransportFailure::class.java) {
      transport.request(requestId, origin, "/api/auth/platform-devices/trust-overview", "GET", "safe", null) {}
    }
    assertEquals("mobile_transport_unavailable", error.code)
    assertEquals(0, server.requestCount)
  }

  @Test fun requestAndCancelRequireAnUnexpiredReservation() {
    val transport = NativeEnrollmentTransport(client)
    val unknown = UUID.randomUUID().toString()
    assertEquals("mobile_transport_invalid", assertThrows(MobileTransportFailure::class.java) {
      transport.request(unknown, origin, "/api/auth/platform-devices/trust-overview", "GET", "safe", null) {}
    }.code)
    assertEquals("mobile_transport_invalid", assertThrows(MobileTransportFailure::class.java) {
      transport.cancelRequest(unknown)
    }.code)
    assertEquals(0, server.requestCount)
  }

  @Test fun retryIsDisabledForDroppedConnections() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    assertTrue(execute("/api/auth/platform-devices/native/mobile/registration/complete", "POST", "{}").isFailure)
    assertEquals(1, server.requestCount)
  }
}
