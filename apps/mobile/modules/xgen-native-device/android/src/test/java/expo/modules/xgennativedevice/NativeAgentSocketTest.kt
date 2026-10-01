package expo.modules.xgennativedevice

import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class NativeAgentSocketTest {
  private lateinit var server: MockWebServer
  private lateinit var client: OkHttpClient
  private lateinit var sockets: NativeAgentSocket
  private lateinit var origin: String
  private val sessionId = "00000000-0000-4000-8000-000000000001"

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
    sockets = NativeAgentSocket(client)
  }

  @After fun tearDown() {
    sockets.closeAll()
    server.shutdown()
  }

  private fun open(id: String = sockets.newSocketId(), originValue: String = origin): Pair<String, Result<Unit>> {
    val result = AtomicReference<Result<Unit>>()
    val latch = CountDownLatch(1)
    sockets.open(id, originValue, sessionId, "9007199254740991", "access.safe.jwt", "proof.safe.jwt") {
      result.set(it)
      latch.countDown()
    }
    assertTrue("open did not complete", latch.await(4, TimeUnit.SECONDS))
    return id to result.get()
  }

  private fun next(id: String): Result<Map<String, String>> {
    val result = AtomicReference<Result<Map<String, String>>>()
    val latch = CountDownLatch(1)
    sockets.next(id) {
      result.set(it)
      latch.countDown()
    }
    assertTrue("next did not complete", latch.await(4, TimeUnit.SECONDS))
    return result.get()
  }

  private fun close(id: String): Result<Unit> {
    val result = AtomicReference<Result<Unit>>()
    val latch = CountDownLatch(1)
    sockets.close(id) {
      result.set(it)
      latch.countDown()
    }
    assertTrue("close did not complete", latch.await(4, TimeUnit.SECONDS))
    return result.get()
  }

  private fun echoingListener(onOpen: ((WebSocket) -> Unit)? = null) = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) { onOpen?.invoke(webSocket) }
    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
  }

  private fun code(result: Result<*>): String = (result.exceptionOrNull() as MobileSocketFailure).code

  @Test fun handshakeUsesCanonicalRouteAndOnlyExplicitCredentialHeaders() {
    server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener { it.send("{\"sequence\":1}") }))
    val (id, opened) = open()
    assertTrue(opened.isSuccess)
    val request = server.takeRequest(1, TimeUnit.SECONDS)!!
    assertEquals("/api/agentflow/agent-sessions/$sessionId/events?after_seq=9007199254740991", request.path)
    assertEquals("DPoP access.safe.jwt", request.getHeader("Authorization"))
    assertEquals("proof.safe.jwt", request.getHeader("DPoP"))
    assertNull(request.getHeader("Cookie"))
    assertNull(request.getHeader("Origin"))
    assertNull(request.getHeader("Sec-WebSocket-Protocol"))
    assertEquals(mapOf("type" to "events", "text" to "{\"sequence\":1}"), next(id).getOrThrow())
    assertTrue(close(id).isSuccess)
  }

  @Test fun cookiesFromOneHandshakeAreNotReused() {
    repeat(2) {
      server.enqueue(MockResponse().addHeader("Set-Cookie", "secret=stored").withWebSocketUpgrade(echoingListener()))
      val (id, opened) = open()
      assertTrue(opened.isSuccess)
      assertNull(server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie"))
      assertTrue(close(id).isSuccess)
    }
  }

  @Test fun rejectsNoncanonicalInputsBeforeNetwork() {
    fun invalid(
      originValue: String = origin,
      session: String = sessionId,
      cursor: String = "0",
      token: String = "access.safe.jwt",
      proof: String = "proof.safe.jwt",
      id: String = sockets.newSocketId()
    ) {
      val error = assertThrows(MobileSocketFailure::class.java) {
        sockets.open(id, originValue, session, cursor, token, proof) { fail("must not complete") }
      }
      assertEquals("mobile_socket_invalid", error.code)
    }
    invalid(originValue = origin.replace("https://", "http://"))
    invalid(originValue = "$origin/path")
    invalid(originValue = origin.replace("localhost", "LOCALHOST"))
    invalid(session = "abcdefab-cdef-4abc-8def-abcdefabcdef".uppercase())
    invalid(session = "00000000-0000-0000-8000-000000000001")
    invalid(session = "00000000-0000-4000-0000-000000000001")
    invalid(cursor = "01")
    invalid(cursor = "9007199254740992")
    invalid(cursor = "-1")
    invalid(token = "opaque")
    invalid(proof = "bad\nproof.jwt")
    invalid(id = UUID.randomUUID().toString().uppercase())
    assertEquals(0, server.requestCount)
  }

  @Test fun reservationsAreCappedExpireAndCannotBeReused() {
    var now = 1_000L
    val transport = NativeAgentSocket(client) { now }
    val ids = (1..64).map { transport.newSocketId() }
    assertEquals("mobile_socket_busy", assertThrows(MobileSocketFailure::class.java) { transport.newSocketId() }.code)
    now += 60_000L
    assertNotNull(transport.newSocketId())
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) {
      transport.open(ids.first(), origin, sessionId, "0", "a.b.c", "d.e.f") {}
    }.code)

    val reserved = transport.newSocketId()
    assertTrue(run {
      val completed = AtomicReference<Result<Unit>>()
      transport.close(reserved) { completed.set(it) }
      completed.get().isSuccess
    })
    assertTrue(run {
      val completed = AtomicReference<Result<Unit>>()
      transport.close(reserved) { completed.set(it) }
      completed.get().isSuccess
    })
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) {
      transport.open(reserved, origin, sessionId, "0", "a.b.c", "d.e.f") {}
    }.code)
    transport.closeAll()
  }

  @Test fun activeSocketsCountTowardTheTrackedLimit() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val transport = NativeAgentSocket(client)
    val ids = (1..64).map { transport.newSocketId() }
    val openLatch = CountDownLatch(1)
    transport.open(ids.first(), origin, sessionId, "0", "a.b.c", "d.e.f") { openLatch.countDown() }
    assertNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    assertEquals("mobile_socket_busy", assertThrows(MobileSocketFailure::class.java) { transport.newSocketId() }.code)
    val closeLatch = CountDownLatch(1)
    transport.close(ids.first()) { closeLatch.countDown() }
    assertTrue(openLatch.await(4, TimeUnit.SECONDS))
    assertTrue(closeLatch.await(4, TimeUnit.SECONDS))
    transport.closeAll()
  }

  @Test fun terminalTombstonesAreBoundedAndExpire() {
    var now = 1_000L
    val transport = NativeAgentSocket(client) { now }
    var oldest = ""
    repeat(300) { index ->
      val id = transport.newSocketId()
      if (index == 0) oldest = id
      transport.close(id) { assertTrue(it.isSuccess) }
    }
    val field = NativeAgentSocket::class.java.getDeclaredField("tombstones").apply { isAccessible = true }
    assertEquals(256, (field.get(transport) as Map<*, *>).size)
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) { transport.close(oldest) {} }.code)

    val recent = transport.newSocketId()
    transport.close(recent) { assertTrue(it.isSuccess) }
    transport.close(recent) { assertTrue(it.isSuccess) }
    now += 60_000L
    transport.newSocketId()
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) { transport.close(recent) {} }.code)
    transport.closeAll()
  }

  @Test fun mapsHandshakeFailuresWithoutFollowingRedirects() {
    listOf(
      MockResponse().setResponseCode(401) to "mobile_socket_authentication",
      MockResponse().setResponseCode(403) to "mobile_socket_authentication",
      MockResponse().setResponseCode(409) to "mobile_socket_cursor_conflict",
      MockResponse().setResponseCode(408) to "mobile_socket_unavailable",
      MockResponse().setResponseCode(429) to "mobile_socket_unavailable",
      MockResponse().setResponseCode(500) to "mobile_socket_unavailable",
      MockResponse().setResponseCode(503) to "mobile_socket_unavailable",
      MockResponse().setResponseCode(302).addHeader("Location", "/escaped") to "mobile_socket_invalid",
      MockResponse().withWebSocketUpgrade(echoingListener())
        .setHeader("Sec-WebSocket-Protocol", "unexpected") to "mobile_socket_invalid"
    ).forEach { (response, expected) ->
      server.enqueue(response)
      val (id, opened) = open()
      assertEquals(expected, code(opened))
      assertTrue(close(id).isSuccess)
    }
    assertEquals(9, server.requestCount)
  }

  @Test fun binaryOversizeAndQueueOverflowFailWithInvalid() {
    fun invalidFrame(send: (WebSocket) -> Unit) {
      val peer = AtomicReference<WebSocket>()
      server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener { peer.set(it) }))
      val (id, opened) = open()
      assertTrue(opened.isSuccess)
      val result = AtomicReference<Result<Map<String, String>>>()
      val latch = CountDownLatch(1)
      sockets.next(id) { result.set(it); latch.countDown() }
      send(peer.get())
      assertTrue(latch.await(4, TimeUnit.SECONDS))
      assertEquals("mobile_socket_invalid", code(result.get()))
      assertTrue(close(id).isSuccess)
    }
    invalidFrame { it.send(byteArrayOf(1, 2, 3).toByteString()) }
    invalidFrame { it.send("x".repeat(1_048_577)) }

    val peer = AtomicReference<WebSocket>()
    server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener { peer.set(it) }))
    val (id, opened) = open()
    assertTrue(opened.isSuccess)
    repeat(9) { assertTrue(peer.get().send("x".repeat(262_145))) }
    Thread.sleep(250)
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4)
    var overflow: Result<Map<String, String>>? = null
    while (System.nanoTime() < deadline) {
      overflow = try {
        val value = AtomicReference<Result<Map<String, String>>>()
        sockets.next(id) { value.set(it) }
        value.get()
      } catch (error: MobileSocketFailure) {
        Result.failure(error)
      }
      if (overflow?.isFailure == true) break
      Thread.sleep(10)
    }
    assertNotNull(overflow)
    assertEquals("mobile_socket_invalid", code(overflow!!))
    assertTrue(close(id).isSuccess)
  }

  @Test fun strictUtf8RejectsUnpairedSurrogates() {
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) {
      NativeAgentSocket.frameBytes("bad\uD800frame")
    }.code)
    assertEquals("mobile_socket_invalid", assertThrows(MobileSocketFailure::class.java) {
      NativeAgentSocket.frameBytes("decoder\uFFFDreplacement")
    }.code)
  }

  @Test fun onlyOneNextMayWaitAndPeerCloseCodesAreStatic() {
    listOf(
      4403 to "mobile_socket_authentication",
      4409 to "mobile_socket_cursor_conflict",
      4400 to "mobile_socket_invalid",
      1002 to "mobile_socket_invalid",
      1003 to "mobile_socket_invalid",
      1007 to "mobile_socket_invalid",
      1009 to "mobile_socket_invalid",
      1011 to "mobile_socket_unavailable",
      1000 to "mobile_socket_unavailable"
    ).forEachIndexed { index, (closeCode, expected) ->
      val peer = AtomicReference<WebSocket>()
      val peerOpen = CountDownLatch(1)
      server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener {
        peer.set(it)
        peerOpen.countDown()
      }))
      val (id, opened) = open()
      assertTrue(opened.isSuccess)
      assertTrue("peer open did not complete", peerOpen.await(4, TimeUnit.SECONDS))
      val first = AtomicReference<Result<Map<String, String>>>()
      val firstLatch = CountDownLatch(1)
      sockets.next(id) { first.set(it); firstLatch.countDown() }
      if (index == 0) {
        assertEquals("mobile_socket_busy", assertThrows(MobileSocketFailure::class.java) { sockets.next(id) {} }.code)
      }
      peer.get().close(closeCode, "secret must not escape")
      assertTrue(firstLatch.await(4, TimeUnit.SECONDS))
      assertEquals(expected, code(first.get()))
      assertTrue(close(id).isSuccess)
    }
  }

  @Test fun cancelBeforeAndAfterOpenWaitsForActualTermination() {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    val openingId = sockets.newSocketId()
    val openResult = AtomicReference<Result<Unit>>()
    val openLatch = CountDownLatch(1)
    sockets.open(openingId, origin, sessionId, "0", "a.b.c", "d.e.f") { openResult.set(it); openLatch.countDown() }
    val closeResult = AtomicReference<Result<Unit>>()
    val closeLatch = CountDownLatch(1)
    assertNotNull(server.takeRequest(1, TimeUnit.SECONDS))
    sockets.close(openingId) { closeResult.set(it); closeLatch.countDown() }
    assertTrue(openLatch.await(4, TimeUnit.SECONDS))
    assertEquals("mobile_socket_unavailable", code(openResult.get()))
    assertTrue(closeLatch.await(4, TimeUnit.SECONDS))
    assertTrue(closeResult.get().isSuccess)

    server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener()))
    val (activeId, opened) = open()
    assertTrue(opened.isSuccess)
    assertTrue(close(activeId).isSuccess)
  }

  @Test fun originStaysClaimedWhileClosingAndCloseAllDisposesTransport() {
    val peer = AtomicReference<WebSocket>()
    val closingSeen = CountDownLatch(1)
    server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) { peer.set(webSocket) }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { closingSeen.countDown() }
    }))
    val (id, opened) = open()
    assertTrue(opened.isSuccess)
    val closeLatch = CountDownLatch(1)
    sockets.close(id) { closeLatch.countDown() }
    assertTrue(closingSeen.await(4, TimeUnit.SECONDS))
    val duplicateId = sockets.newSocketId()
    assertEquals("mobile_socket_busy", assertThrows(MobileSocketFailure::class.java) {
      sockets.open(duplicateId, origin, sessionId, "0", "a.b.c", "d.e.f") {}
    }.code)
    peer.get().close(1000, null)
    assertTrue(closeLatch.await(4, TimeUnit.SECONDS))

    server.enqueue(MockResponse().withWebSocketUpgrade(echoingListener()))
    val (activeId, openedAgain) = open()
    assertTrue(openedAgain.isSuccess)
    val pending = AtomicReference<Result<Map<String, String>>>()
    val pendingLatch = CountDownLatch(1)
    sockets.next(activeId) { pending.set(it); pendingLatch.countDown() }
    sockets.closeAll()
    assertTrue(pendingLatch.await(4, TimeUnit.SECONDS))
    assertEquals("mobile_socket_unavailable", code(pending.get()))
    assertEquals("mobile_socket_unavailable", assertThrows(MobileSocketFailure::class.java) { sockets.newSocketId() }.code)
  }

  @Test fun productionClientDisablesAmbientCredentialsRedirectsAndRetries() {
    val transport = NativeAgentSocket.production()
    val field = NativeAgentSocket::class.java.getDeclaredField("client").apply { isAccessible = true }
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
    transport.closeAll()
  }
}
