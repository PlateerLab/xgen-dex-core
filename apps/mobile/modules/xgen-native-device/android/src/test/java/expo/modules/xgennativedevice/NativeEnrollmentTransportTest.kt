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

  private fun executeSession(path: String, method: String = "POST", authorization: String? = null, dpop: String? = null, body: String? = "{}"): Result<MobileTransportResponse> {
    val result = AtomicReference<Result<MobileTransportResponse>>()
    val latch = CountDownLatch(1)
    val transport = NativeEnrollmentTransport(client)
    transport.sessionRequest(transport.newRequestId(), origin, path, method, authorization, dpop, body) {
      result.set(it); latch.countDown()
    }
    assertTrue("session request did not complete", latch.await(4, TimeUnit.SECONDS))
    return result.get()
  }

  private fun executeRead(pathWithQuery: String, accessToken: String = "access.safe.jwt", dpop: String = "proof.safe.jwt"): Result<MobileTransportResponse> {
    val result = AtomicReference<Result<MobileTransportResponse>>()
    val latch = CountDownLatch(1)
    val transport = NativeEnrollmentTransport(client)
    transport.readRequest(transport.newRequestId(), origin, pathWithQuery, accessToken, dpop) {
      result.set(it); latch.countDown()
    }
    assertTrue("read request did not complete", latch.await(4, TimeUnit.SECONDS))
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

  @Test fun sessionRoutesUseExactAuthenticationPolicies() {
    repeat(3) { server.enqueue(MockResponse().setResponseCode(200).setBody("{}")) }
    assertTrue(executeSession("/api/auth/platform-sessions/native/login-key/begin", authorization = "Bearer login.safe").isSuccess)
    assertTrue(executeSession("/api/auth/platform-sessions/native/refresh/complete").isSuccess)
    val proof = "a.b.c"
    assertTrue(executeSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "DPoP access.safe.jwt", proof, "{\"password\":\"pw\"}").isSuccess)

    val login = server.takeRequest(1, TimeUnit.SECONDS)!!
    assertEquals("Bearer login.safe", login.getHeader("Authorization")); assertNull(login.getHeader("DPoP"))
    assertEquals("application/json", login.getHeader("Content-Type"))
    val refresh = server.takeRequest(1, TimeUnit.SECONDS)!!
    assertNull(refresh.getHeader("Authorization")); assertNull(refresh.getHeader("DPoP"))
    val delete = server.takeRequest(1, TimeUnit.SECONDS)!!
    assertEquals("DELETE", delete.method); assertEquals("DPoP access.safe.jwt", delete.getHeader("Authorization"))
    assertEquals(proof, delete.getHeader("DPoP")); assertEquals("application/json", delete.getHeader("Content-Type")); assertEquals("{\"password\":\"pw\"}", delete.body.readUtf8())
  }

  @Test fun sessionRequestRejectsWrongRouteAuthenticationAndBodyBeforeNetwork() {
    val transport = NativeEnrollmentTransport(client)
    fun invalid(path: String, method: String = "POST", authorization: String? = null, dpop: String? = null, body: String? = "{}") {
      val error = assertThrows(MobileTransportFailure::class.java) {
        transport.sessionRequest(transport.newRequestId(), origin, path, method, authorization, dpop, body) { fail("must not complete") }
      }
      assertEquals("mobile_transport_invalid", error.code)
    }
    invalid("/api/auth/platform-sessions/native/login-key/begin")
    invalid("/api/auth/platform-sessions/native/login-key/complete", authorization = "Bearer unsafe+")
    invalid("/api/auth/platform-sessions/native/login-key/begin", authorization = "Bearer safe", dpop = "a.b.c")
    invalid("/api/auth/platform-sessions/native/refresh/begin", authorization = "Bearer safe")
    invalid("/api/auth/platform-sessions/native/refresh/complete", dpop = "a.b.c")
    invalid("/api/auth/platform-sessions/native/refresh/begin", body = "{\"x\":\"\uD800\"}")
    invalid("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "Bearer safe.jwt", "a.b.c", "{}")
    invalid("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "DPoP safe.jwt.token", "bad", "{}")
    invalid("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "DPoP opaque-safe", "a.b.c", "{}")
    invalid("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "DPoP safe.jwt.token", "a.b.c", null)
    invalid("/api/me/platform-sessions/00000000-0000-0000-0000-000000000001", "DELETE", "DPoP safe.jwt.token", "a.b.c", "{}")
    invalid("/api/agentflow/me/agent-state", "GET", "DPoP safe", "a.b.c", null)
    invalid("/api/auth/platform-sessions/native/refresh/begin?x=1")
    assertEquals(0, server.requestCount)
  }

  @Test fun enrollmentAndSessionRequestsShareReservationsAndCancellation() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val transport = NativeEnrollmentTransport(client)
    val id = transport.newRequestId()
    val latch = CountDownLatch(1)
    transport.request(id, origin, "/api/auth/platform-devices/trust-overview", "GET", "safe", null) { latch.countDown() }
    val duplicate = assertThrows(MobileTransportFailure::class.java) {
      transport.sessionRequest(id, origin, "/api/auth/platform-sessions/native/refresh/begin", "POST", null, null, "{}") {}
    }
    assertEquals("mobile_transport_busy", duplicate.code)
    transport.cancelRequest(id)
    assertTrue(latch.await(2, TimeUnit.SECONDS))

    val cancelled = transport.newRequestId()
    transport.cancelRequest(cancelled)
    assertEquals("mobile_transport_unavailable", assertThrows(MobileTransportFailure::class.java) {
      transport.sessionRequest(cancelled, origin, "/api/auth/platform-sessions/native/refresh/begin", "POST", null, null, "{}") {}
    }.code)
  }

  @Test fun sessionPostAndDeleteDroppedConnectionsAreNotRetried() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    assertTrue(executeSession("/api/auth/platform-sessions/native/login-key/complete", authorization = "Bearer safe").isFailure)
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    assertTrue(executeSession("/api/me/platform-sessions/00000000-0000-4000-8000-000000000001", "DELETE", "DPoP safe.jwt.token", "a.b.c", "{\"password\":\"pw\"}").isFailure)
    assertEquals(2, server.requestCount)
  }

  @Test fun canonicalReadsPreserveExactQueriesAndSendOnlyDpopHeaders() {
    val session = "00000000-0000-4000-8000-000000000001"
    val routes = listOf(
      "/api/agentflow/me/agent-state",
      "/api/agentflow/me/agent-events?after_sequence=9007199254740991&limit=200",
      "/api/agentflow/me/agent-sessions?limit=100",
      "/api/agentflow/me/agent-sessions?limit=20&before_id=$session",
      "/api/agentflow/agent-sessions/$session/snapshot",
      "/api/agentflow/agent-sessions/$session/events?after_sequence=0&limit=1"
    )
    routes.forEach { server.enqueue(MockResponse().setResponseCode(200).setBody("{}")) }
    routes.forEach { assertTrue(executeRead(it).isSuccess) }
    routes.forEach { expected ->
      val request = server.takeRequest(1, TimeUnit.SECONDS)!!
      assertEquals("GET", request.method)
      assertEquals(expected, request.path)
      assertEquals("application/json", request.getHeader("Accept"))
      assertEquals("DPoP access.safe.jwt", request.getHeader("Authorization"))
      assertEquals("proof.safe.jwt", request.getHeader("DPoP"))
      assertNull(request.getHeader("Content-Type"))
      assertEquals(0L, request.bodySize)
    }
  }

  @Test fun canonicalReadsRejectRewrittenQueriesBoundsAndCredentialsBeforeNetwork() {
    val transport = NativeEnrollmentTransport(client)
    val session = "00000000-0000-4000-8000-000000000001"
    fun invalid(path: String, token: String = "access.safe.jwt", proof: String = "proof.safe.jwt", originValue: String = origin) {
      val error = assertThrows(MobileTransportFailure::class.java) {
        transport.readRequest(transport.newRequestId(), originValue, path, token, proof) { fail("must not complete") }
      }
      assertEquals("mobile_transport_invalid", error.code)
    }
    listOf(
      "/api/agentflow/me/agent-state?x=1",
      "/api/agentflow/me/agent-events",
      "/api/agentflow/me/agent-events?limit=1&after_sequence=0",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=1&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=01&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=9007199254740992&limit=1",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=0",
      "/api/agentflow/me/agent-events?after_sequence=0&limit=201",
      "/api/agentflow/me/agent-sessions?limit=101",
      "/api/agentflow/me/agent-sessions?before_id=$session&limit=1",
      "/api/agentflow/me/agent-sessions?limit=1&before_id=00000000-0000-0000-0000-000000000001",
      "/api/agentflow/me/agent-sessions?limit=1&before_id=00000000-0000-4000-8000-00000000000A",
      "/api/agentflow/agent-sessions/$session/events?after_sequence=0&limit=01",
      "/api/agentflow/agent-sessions/$session/snapshot?x=1",
      "/api/agentflow/me/agent-events?after_sequence=0%26limit=1&limit=1",
      "/api/agentflow/me/agent-state#fragment",
      "/api/agentflow/me\\agent-state"
    ).forEach(::invalid)
    invalid("/api/agentflow/me/agent-state", token = "access.safe.jwt\n")
    invalid("/api/agentflow/me/agent-state", proof = "proof.safe.jwt\n")
    invalid("/api/agentflow/me/agent-state", token = "opaque-token")
    invalid("/api/agentflow/me/agent-state", proof = "opaque-proof")
    invalid("/api/agentflow/me/agent-state", token = "a".repeat(8_189) + ".b.c")
    invalid("/api/agentflow/me/agent-state", originValue = origin.replace("localhost", "LOCALHOST"))
    invalid("/api/agentflow/me/agent-state", originValue = "https://localhost:443")
    assertEquals(0, server.requestCount)
  }

  @Test fun canonicalReadSharesReservationAndCancellationWithMutationTransports() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val transport = NativeEnrollmentTransport(client)
    val id = transport.newRequestId()
    val result = AtomicReference<Result<MobileTransportResponse>>()
    val latch = CountDownLatch(1)
    transport.readRequest(id, origin, "/api/agentflow/me/agent-state", "access.safe.jwt", "proof.safe.jwt") {
      result.set(it); latch.countDown()
    }
    assertEquals("mobile_transport_busy", assertThrows(MobileTransportFailure::class.java) {
      transport.sessionRequest(id, origin, "/api/auth/platform-sessions/native/refresh/begin", "POST", null, null, "{}") {}
    }.code)
    transport.cancelRequest(id)
    assertTrue(latch.await(2, TimeUnit.SECONDS))
    assertEquals("mobile_transport_unavailable", (result.get().exceptionOrNull() as MobileTransportFailure).code)

    val cancelled = transport.newRequestId()
    transport.cancelRequest(cancelled)
    assertEquals("mobile_transport_unavailable", assertThrows(MobileTransportFailure::class.java) {
      transport.readRequest(cancelled, origin, "/api/agentflow/me/agent-state", "access.safe.jwt", "proof.safe.jwt") {}
    }.code)
  }
}
