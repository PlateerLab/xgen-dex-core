package expo.modules.xgennativedevice

import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.URI
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.TimeUnit

internal class MobileSocketFailure(val code: String) : Exception(code)

/** A receive-only, credential-carrying WebSocket for canonical agent events. */
internal class NativeAgentSocket internal constructor(
  private val client: OkHttpClient,
  private val nowMillis: () -> Long = System::currentTimeMillis
) {
  companion object {
    private const val MAX_TRACKED_SOCKETS = 64
    private const val RESERVATION_TTL_MILLIS = 60_000L
    private const val MAX_TOMBSTONES = 256
    private const val TOMBSTONE_TTL_MILLIS = 60_000L
    private const val MAX_FRAME_BYTES = 1_048_576
    private const val MAX_QUEUED_FRAMES = 8
    private const val MAX_QUEUED_BYTES = 2_097_152
    private const val MAX_SAFE_SEQUENCE = "9007199254740991"
    private val decimalPattern = Regex("0|[1-9][0-9]*")
    private val jwtPattern = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")

    fun production(): NativeAgentSocket = NativeAgentSocket(
      OkHttpClient.Builder()
        .retryOnConnectionFailure(false)
        .followRedirects(false)
        .followSslRedirects(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE)
        .cache(null)
        .callTimeout(10, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()
    )

    private fun canonicalUuid(value: String): UUID? = try {
      UUID.fromString(value).takeIf {
        it.toString() == value && it.version() in 1..8 && it.variant() == 2
      }
    } catch (_: IllegalArgumentException) {
      null
    }

    private fun validatedOrigin(origin: String): okhttp3.HttpUrl {
      val uri = try { URI(origin) } catch (_: Exception) { throw MobileSocketFailure("mobile_socket_invalid") }
      if (uri.scheme != "https" || uri.host == null || uri.rawUserInfo != null || uri.rawPath?.isNotEmpty() == true ||
        uri.rawQuery != null || uri.rawFragment != null || uri.toASCIIString() != origin
      ) throw MobileSocketFailure("mobile_socket_invalid")
      val parsed = origin.toHttpUrlOrNull() ?: throw MobileSocketFailure("mobile_socket_invalid")
      if (parsed.scheme != "https" || parsed.username.isNotEmpty() || parsed.password.isNotEmpty() ||
        parsed.encodedPath != "/" || parsed.query != null || parsed.fragment != null ||
        parsed.toString().removeSuffix("/") != origin
      ) throw MobileSocketFailure("mobile_socket_invalid")
      return parsed
    }

    private fun canonicalSequence(value: String): Boolean =
      decimalPattern.matches(value) &&
        (value.length < MAX_SAFE_SEQUENCE.length || value.length == MAX_SAFE_SEQUENCE.length && value <= MAX_SAFE_SEQUENCE)

    private fun credential(value: String): Boolean = value.length <= 8_192 && jwtPattern.matches(value)

    private fun buildRequest(
      origin: String,
      sessionId: String,
      afterSequence: String,
      accessToken: String,
      dpop: String
    ): Request {
      val base = validatedOrigin(origin)
      if (canonicalUuid(sessionId) == null || !canonicalSequence(afterSequence) ||
        !credential(accessToken) || !credential(dpop)
      ) throw MobileSocketFailure("mobile_socket_invalid")
      val path = "/api/agentflow/agent-sessions/$sessionId/events?after_seq=$afterSequence"
      val expected = origin + path
      val url = expected.toHttpUrlOrNull()
      if (url == null || url.toString() != expected) throw MobileSocketFailure("mobile_socket_invalid")
      return Request.Builder()
        .url(base.newBuilder().encodedPath("/api/agentflow/agent-sessions/$sessionId/events").encodedQuery("after_seq=$afterSequence").build())
        .header("Authorization", "DPoP $accessToken")
        .header("DPoP", dpop)
        .get()
        .build()
    }

    internal fun frameBytes(text: String): ByteArray = try {
      // OkHttp exposes decoded text rather than the original bytes. U+FFFD is how its decoder
      // reports malformed wire input, so reject it rather than accepting a lossy frame.
      if ('\uFFFD' in text) throw MobileSocketFailure("mobile_socket_invalid")
      val encoded = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(text))
      ByteArray(encoded.remaining()).also { encoded.get(it) }
    } catch (_: Exception) {
      throw MobileSocketFailure("mobile_socket_invalid")
    }

    private fun responseFailure(response: Response?): MobileSocketFailure = MobileSocketFailure(when (response?.code) {
      401, 403 -> "mobile_socket_authentication"
      409 -> "mobile_socket_cursor_conflict"
      408, 429, in 500..599, null -> "mobile_socket_unavailable"
      else -> "mobile_socket_invalid"
    })

    private fun closeFailure(code: Int): MobileSocketFailure = MobileSocketFailure(when (code) {
      1008, 4401, 4403 -> "mobile_socket_authentication"
      4409 -> "mobile_socket_cursor_conflict"
      1002, 1003, 1007, 1009, 4400 -> "mobile_socket_invalid"
      else -> "mobile_socket_unavailable"
    })
  }

  private enum class Phase { RESERVED, OPENING, OPEN, CLOSING }
  private data class Frame(val text: String, val bytes: Int)
  private data class Tombstone(val terminatedAt: Long, val failure: MobileSocketFailure?)
  private class Entry(val reservedAt: Long) {
    var phase = Phase.RESERVED
    var origin: String? = null
    var expectedUrl: String? = null
    var socket: WebSocket? = null
    var openCompletion: ((Result<Unit>) -> Unit)? = null
    var nextCompletion: ((Result<Map<String, String>>) -> Unit)? = null
    val closeCompletions = mutableListOf<(Result<Unit>) -> Unit>()
    val frames = ArrayDeque<Frame>()
    var queuedBytes = 0
    var terminalFailure: MobileSocketFailure? = null
  }

  private val lock = Any()
  private val entries = LinkedHashMap<String, Entry>()
  private val tombstones = LinkedHashMap<String, Tombstone>()
  private val claimedOrigins = HashSet<String>()
  private var disposed = false

  private fun pruneReservationsLocked(now: Long) {
    val iterator = entries.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      if (entry.value.phase == Phase.RESERVED && now - entry.value.reservedAt >= RESERVATION_TTL_MILLIS) {
        val id = entry.key
        iterator.remove()
        putTombstoneLocked(id, null, now)
      }
    }
  }

  private fun pruneTombstonesLocked(now: Long) {
    val iterator = tombstones.iterator()
    while (iterator.hasNext()) {
      if (now - iterator.next().value.terminatedAt >= TOMBSTONE_TTL_MILLIS) iterator.remove()
    }
    while (tombstones.size > MAX_TOMBSTONES) tombstones.remove(tombstones.entries.first().key)
  }

  private fun putTombstoneLocked(socketId: String, failure: MobileSocketFailure?, now: Long = nowMillis()) {
    tombstones.remove(socketId)
    tombstones[socketId] = Tombstone(now, failure)
    pruneTombstonesLocked(now)
  }

  fun newSocketId(): String = synchronized(lock) {
    if (disposed) throw MobileSocketFailure("mobile_socket_unavailable")
    val now = nowMillis()
    pruneReservationsLocked(now)
    pruneTombstonesLocked(now)
    if (entries.size >= MAX_TRACKED_SOCKETS) {
      throw MobileSocketFailure("mobile_socket_busy")
    }
    var id: String
    do { id = UUID.randomUUID().toString() } while (entries.containsKey(id) || tombstones.containsKey(id))
    entries[id] = Entry(now)
    id
  }

  fun open(
    socketId: String,
    origin: String,
    sessionId: String,
    afterSequence: String,
    accessToken: String,
    dpop: String,
    completion: (Result<Unit>) -> Unit
  ) {
    if (canonicalUuid(socketId) == null) throw MobileSocketFailure("mobile_socket_invalid")
    val request = buildRequest(origin, sessionId, afterSequence, accessToken, dpop)
    val entry = synchronized(lock) {
      if (disposed) throw MobileSocketFailure("mobile_socket_unavailable")
      pruneReservationsLocked(nowMillis())
      val reserved = entries[socketId] ?: throw MobileSocketFailure("mobile_socket_invalid")
      if (reserved.phase != Phase.RESERVED || claimedOrigins.contains(origin)) {
        throw MobileSocketFailure("mobile_socket_busy")
      }
      reserved.phase = Phase.OPENING
      reserved.origin = origin
      reserved.expectedUrl = request.url.toString()
      reserved.openCompletion = completion
      claimedOrigins.add(origin)
      reserved
    }

    val listener = Listener(socketId)
    val socket = try {
      client.newWebSocket(request, listener)
    } catch (_: Exception) {
      finish(socketId, MobileSocketFailure("mobile_socket_unavailable"))
      return
    }
    val cancel = synchronized(lock) {
      if (entries[socketId] !== entry) true
      else {
        entry.socket = socket
        entry.phase == Phase.CLOSING
      }
    }
    if (cancel) socket.cancel()
  }

  fun next(socketId: String, completion: (Result<Map<String, String>>) -> Unit) {
    if (canonicalUuid(socketId) == null) throw MobileSocketFailure("mobile_socket_invalid")
    var immediate: Result<Map<String, String>>? = null
    synchronized(lock) {
      pruneTombstonesLocked(nowMillis())
      if (disposed && !entries.containsKey(socketId) && !tombstones.containsKey(socketId)) {
        throw MobileSocketFailure("mobile_socket_unavailable")
      }
      val entry = entries[socketId]
      if (entry == null) {
        tombstones[socketId]?.failure?.let { immediate = Result.failure(it) }
          ?: throw MobileSocketFailure(if (tombstones.containsKey(socketId)) "mobile_socket_unavailable" else "mobile_socket_invalid")
        return@synchronized
      }
      if (entry.nextCompletion != null) throw MobileSocketFailure("mobile_socket_busy")
      when (entry.phase) {
        Phase.OPEN -> {
          val frame = entry.frames.pollFirst()
          if (frame == null) entry.nextCompletion = completion
          else {
            entry.queuedBytes -= frame.bytes
            immediate = Result.success(mapOf("type" to "events", "text" to frame.text))
          }
        }
        Phase.CLOSING -> immediate = Result.failure(entry.terminalFailure ?: MobileSocketFailure("mobile_socket_unavailable"))
        else -> throw MobileSocketFailure("mobile_socket_invalid")
      }
    }
    immediate?.let(completion)
  }

  fun close(socketId: String, completion: (Result<Unit>) -> Unit) {
    if (canonicalUuid(socketId) == null) throw MobileSocketFailure("mobile_socket_invalid")
    var socket: WebSocket? = null
    var cancel = false
    var immediate = false
    var openCompletion: ((Result<Unit>) -> Unit)? = null
    var nextCompletion: ((Result<Map<String, String>>) -> Unit)? = null
    synchronized(lock) {
      val now = nowMillis()
      pruneReservationsLocked(now)
      pruneTombstonesLocked(now)
      val entry = entries[socketId]
      if (entry == null) {
        if (!tombstones.containsKey(socketId)) {
          if (disposed) throw MobileSocketFailure("mobile_socket_unavailable")
          throw MobileSocketFailure("mobile_socket_invalid")
        }
        putTombstoneLocked(socketId, null, now)
        immediate = true
      } else when (entry.phase) {
        Phase.RESERVED -> {
          entries.remove(socketId)
          putTombstoneLocked(socketId, null, now)
          immediate = true
        }
        Phase.OPENING, Phase.OPEN -> {
          cancel = entry.phase == Phase.OPENING
          entry.phase = Phase.CLOSING
          entry.terminalFailure = MobileSocketFailure("mobile_socket_unavailable")
          entry.closeCompletions.add(completion)
          openCompletion = entry.openCompletion.also { entry.openCompletion = null }
          nextCompletion = entry.nextCompletion.also { entry.nextCompletion = null }
          socket = entry.socket
        }
        Phase.CLOSING -> {
          if (entry.closeCompletions.isNotEmpty()) throw MobileSocketFailure("mobile_socket_busy")
          entry.closeCompletions.add(completion)
        }
      }
    }
    openCompletion?.invoke(Result.failure(MobileSocketFailure("mobile_socket_unavailable")))
    nextCompletion?.invoke(Result.failure(MobileSocketFailure("mobile_socket_unavailable")))
    if (immediate) completion(Result.success(Unit))
    else if (cancel) socket?.cancel()
    // OkHttp 4.9.2 waits for the peer close frame, then cancels after 60 seconds.
    // Resolve only from the resulting onClosed/onFailure callback below.
    else if (socket != null && socket?.close(1000, null) != true) socket?.cancel()
  }

  fun closeAll() {
    val sockets = mutableListOf<WebSocket>()
    val opens = mutableListOf<(Result<Unit>) -> Unit>()
    val nexts = mutableListOf<(Result<Map<String, String>>) -> Unit>()
    synchronized(lock) {
      disposed = true
      val iterator = entries.iterator()
      while (iterator.hasNext()) {
        val (id, entry) = iterator.next()
        if (entry.phase == Phase.RESERVED) {
          iterator.remove()
          putTombstoneLocked(id, null)
          continue
        }
        entry.phase = Phase.CLOSING
        entry.terminalFailure = MobileSocketFailure("mobile_socket_unavailable")
        entry.openCompletion?.let(opens::add)
        entry.openCompletion = null
        entry.nextCompletion?.let(nexts::add)
        entry.nextCompletion = null
        entry.socket?.let(sockets::add)
      }
    }
    opens.forEach { it(Result.failure(MobileSocketFailure("mobile_socket_unavailable"))) }
    nexts.forEach { it(Result.failure(MobileSocketFailure("mobile_socket_unavailable"))) }
    sockets.forEach { it.cancel() }
  }

  private fun finish(socketId: String, failure: MobileSocketFailure) {
    var open: ((Result<Unit>) -> Unit)? = null
    var next: ((Result<Map<String, String>>) -> Unit)? = null
    var closes: List<(Result<Unit>) -> Unit> = emptyList()
    synchronized(lock) {
      val entry = entries.remove(socketId) ?: return
      entry.origin?.let(claimedOrigins::remove)
      open = entry.openCompletion
      next = entry.nextCompletion
      closes = entry.closeCompletions.toList()
      putTombstoneLocked(socketId, if (closes.isEmpty()) failure else null)
    }
    open?.invoke(Result.failure(failure))
    next?.invoke(Result.failure(failure))
    closes.forEach { it(Result.success(Unit)) }
  }

  private fun failAndClose(socketId: String, socket: WebSocket, failure: MobileSocketFailure, closeCode: Int) {
    var open: ((Result<Unit>) -> Unit)? = null
    var next: ((Result<Map<String, String>>) -> Unit)? = null
    synchronized(lock) {
      val entry = entries[socketId] ?: return
      if (entry.phase == Phase.CLOSING) return
      entry.phase = Phase.CLOSING
      entry.terminalFailure = failure
      entry.frames.clear()
      entry.queuedBytes = 0
      open = entry.openCompletion
      entry.openCompletion = null
      next = entry.nextCompletion
      entry.nextCompletion = null
    }
    open?.invoke(Result.failure(failure))
    next?.invoke(Result.failure(failure))
    if (!socket.close(closeCode, null)) socket.cancel()
  }

  private inner class Listener(private val socketId: String) : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      val expectedUrl = synchronized(lock) { entries[socketId]?.expectedUrl }
      if (response.code != 101 || response.header("Sec-WebSocket-Protocol") != null ||
        response.header("Sec-WebSocket-Extensions") != null || response.request.url.toString() != expectedUrl
      ) {
        failAndClose(socketId, webSocket, MobileSocketFailure("mobile_socket_invalid"), 1002)
        return
      }
      var completion: ((Result<Unit>) -> Unit)? = null
      var rejectLateOpen = false
      synchronized(lock) {
        val entry = entries[socketId]
        if (entry == null || entry.phase != Phase.OPENING) rejectLateOpen = true
        else {
          entry.phase = Phase.OPEN
          entry.socket = webSocket
          completion = entry.openCompletion
          entry.openCompletion = null
        }
      }
      if (rejectLateOpen) webSocket.cancel()
      else completion?.invoke(Result.success(Unit))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      val bytes = try { frameBytes(text) } catch (error: MobileSocketFailure) {
        failAndClose(socketId, webSocket, error, 1007)
        return
      }
      if (bytes.size > MAX_FRAME_BYTES) {
        failAndClose(socketId, webSocket, MobileSocketFailure("mobile_socket_invalid"), 1009)
        return
      }
      var completion: ((Result<Map<String, String>>) -> Unit)? = null
      var overflow = false
      synchronized(lock) {
        val entry = entries[socketId] ?: return
        if (entry.phase != Phase.OPEN) return
        completion = entry.nextCompletion
        if (completion != null) entry.nextCompletion = null
        else if (entry.frames.size >= MAX_QUEUED_FRAMES || entry.queuedBytes + bytes.size > MAX_QUEUED_BYTES) overflow = true
        else {
          entry.frames.addLast(Frame(text, bytes.size))
          entry.queuedBytes += bytes.size
        }
      }
      if (overflow) failAndClose(socketId, webSocket, MobileSocketFailure("mobile_socket_invalid"), 1009)
      else completion?.invoke(Result.success(mapOf("type" to "events", "text" to text)))
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
      failAndClose(socketId, webSocket, MobileSocketFailure("mobile_socket_invalid"), 1003)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      val failure = closeFailure(code)
      var open: ((Result<Unit>) -> Unit)? = null
      var next: ((Result<Map<String, String>>) -> Unit)? = null
      synchronized(lock) {
        val entry = entries[socketId] ?: return
        if (entry.terminalFailure == null) entry.terminalFailure = failure
        entry.phase = Phase.CLOSING
        open = entry.openCompletion.also { entry.openCompletion = null }
        next = entry.nextCompletion.also { entry.nextCompletion = null }
      }
      open?.invoke(Result.failure(failure))
      next?.invoke(Result.failure(failure))
      webSocket.close(code, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      val failure = synchronized(lock) { entries[socketId]?.terminalFailure } ?: closeFailure(code)
      finish(socketId, failure)
    }

    override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
      val failure = synchronized(lock) { entries[socketId]?.terminalFailure } ?: responseFailure(response)
      finish(socketId, failure)
    }
  }
}
