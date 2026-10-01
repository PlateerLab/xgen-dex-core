package expo.modules.xgennativedevice

import okhttp3.Authenticator
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.math.BigDecimal
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit

internal class MobileTransportFailure(val code: String) : Exception(code)

internal data class MobileTransportResponse(val status: Int, val body: String)

/**
 * Narrow, credential-carrying transport for native mobile enrollment only.
 *
 * The production factory is the only caller outside tests. Test client injection exists so a
 * loopback TLS fixture can use its own CA without changing production trust verification.
 */
internal class NativeEnrollmentTransport internal constructor(private val client: OkHttpClient) {
  companion object {
    private const val MAX_REQUEST_BODY_BYTES = 32_768
    private const val MAX_TURN_REQUEST_BODY_BYTES = 2_097_152
    private const val MAX_RESPONSE_BODY_BYTES = 65_536
    private const val MAX_MESSAGES_RESPONSE_BODY_BYTES = 1_048_576
    private const val MAX_TRACKED_REQUESTS = 1_024
    private const val RESERVATION_TTL_MILLIS = 60_000L
    private val JSON = "application/json".toMediaType()
    private val accessTokenPattern = Regex("[A-Za-z0-9._~-]{1,8192}")
    private val dpopPattern = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
    private val statusPath = Regex("/api/auth/platform-devices/native/mobile/registration/status/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
    private val approvalBeginPath = Regex("/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests/begin")
    private val approvalPath = Regex("/api/me/devices/native/mobile/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/approval-requests")
    private val sessionPath = Regex("/api/me/platform-sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private const val CANONICAL_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
    private const val MAX_SAFE_SEQUENCE = "9007199254740991"
    private val agentEventsPath = Regex("/api/agentflow/me/agent-events\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)")
    private val agentSessionsPath = Regex("/api/agentflow/me/agent-sessions\\?limit=([1-9][0-9]*)(?:&before_id=($CANONICAL_UUID))?")
    private val sessionSnapshotPath = Regex("/api/agentflow/agent-sessions/$CANONICAL_UUID/snapshot")
    private val sessionEventsPath = Regex("/api/agentflow/agent-sessions/$CANONICAL_UUID/events\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)")
    private val sessionMessagesPath = Regex("/api/agentflow/agent-sessions/$CANONICAL_UUID/messages\\?after_sequence=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)")
    private val sessionTurnPath = Regex("/api/agentflow/agent-sessions/$CANONICAL_UUID/(turns|stop)")
    private val canonicalUuidPattern = Regex(CANONICAL_UUID)
    private val stableAscii = Regex("[!-~]{1,128}")
    private val maximumSafeVersion = BigDecimal("9007199254740991")

    fun production(): NativeEnrollmentTransport = NativeEnrollmentTransport(
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

    fun isCanonicalUuid(value: String): Boolean = try {
      UUID.fromString(value).toString() == value
    } catch (_: IllegalArgumentException) {
      false
    }

    private fun allowed(method: String, path: String): Boolean = when (method) {
      "GET" -> path == "/api/auth/platform-devices/trust-overview" || statusPath.matches(path)
      "POST" -> path == "/api/auth/platform-devices/native/mobile/registration/challenge" ||
        path == "/api/auth/platform-devices/native/mobile/registration/complete" ||
        approvalBeginPath.matches(path) || approvalPath.matches(path)
      else -> false
    }

    private fun validatedOrigin(origin: String): HttpUrl {
      val uri = try { URI(origin) } catch (_: Exception) { throw MobileTransportFailure("mobile_transport_invalid") }
      if (uri.scheme != "https" || uri.host == null || uri.rawUserInfo != null || uri.rawPath?.isNotEmpty() == true ||
        uri.rawQuery != null || uri.rawFragment != null || uri.toASCIIString() != origin
      ) throw MobileTransportFailure("mobile_transport_invalid")
      val parsed = origin.toHttpUrlOrNull() ?: throw MobileTransportFailure("mobile_transport_invalid")
      if (parsed.scheme != "https" || parsed.username.isNotEmpty() || parsed.password.isNotEmpty() ||
        parsed.encodedPath != "/" || parsed.query != null || parsed.fragment != null
      ) throw MobileTransportFailure("mobile_transport_invalid")
      return parsed
    }

    private fun buildRequest(origin: String, path: String, method: String, accessToken: String, body: String?): Request {
      val base = validatedOrigin(origin)
      if (!allowed(method, path) || '%' in path || '?' in path || '#' in path || '\\' in path) {
        throw MobileTransportFailure("mobile_transport_invalid")
      }
      if (!accessTokenPattern.matches(accessToken)) {
        throw MobileTransportFailure("mobile_transport_invalid")
      }
      val requestBody = when (method) {
        "GET" -> {
          if (body != null) throw MobileTransportFailure("mobile_transport_invalid")
          null
        }
        "POST" -> {
          val value = body ?: throw MobileTransportFailure("mobile_transport_invalid")
          val bytes = strictUtf8(value)
          if (bytes.size > MAX_REQUEST_BODY_BYTES || !StrictJsonObject.isValid(value)) {
            throw MobileTransportFailure("mobile_transport_invalid")
          }
          bytes.toRequestBody(JSON)
        }
        else -> throw MobileTransportFailure("mobile_transport_invalid")
      }
      val url = base.newBuilder().encodedPath(path).build()
      return Request.Builder()
        .url(url)
        .header("Accept", "application/json")
        .header("Authorization", "Bearer $accessToken")
        .method(method, requestBody)
        .build()
    }

    private fun jsonRequestBody(body: String?): okhttp3.RequestBody {
      val value = body ?: throw MobileTransportFailure("mobile_transport_invalid")
      val bytes = strictUtf8(value)
      if (bytes.size > MAX_REQUEST_BODY_BYTES || !StrictJsonObject.isValid(value)) {
        throw MobileTransportFailure("mobile_transport_invalid")
      }
      return bytes.toRequestBody(JSON)
    }

    private fun strictUtf8(value: String): ByteArray = try {
      val buffer = StandardCharsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(value))
      ByteArray(buffer.remaining()).also { buffer.get(it) }
    } catch (_: Exception) {
      throw MobileTransportFailure("mobile_transport_invalid")
    }

    private fun buildSessionRequest(
      origin: String,
      path: String,
      method: String,
      authorization: String?,
      dpop: String?,
      body: String?
    ): Request {
      val base = validatedOrigin(origin)
      if ('%' in path || '?' in path || '#' in path || '\\' in path) throw MobileTransportFailure("mobile_transport_invalid")
      val requestBody: okhttp3.RequestBody?
      when {
        method == "POST" && (path == "/api/auth/platform-sessions/native/login-key/begin" || path == "/api/auth/platform-sessions/native/login-key/complete") -> {
          val token = authorization?.removePrefix("Bearer ")
          if (token == authorization || token == null || !accessTokenPattern.matches(token) || dpop != null) {
            throw MobileTransportFailure("mobile_transport_invalid")
          }
          requestBody = jsonRequestBody(body)
        }
        method == "POST" && (path == "/api/auth/platform-sessions/native/refresh/begin" || path == "/api/auth/platform-sessions/native/refresh/complete") -> {
          if (authorization != null || dpop != null) throw MobileTransportFailure("mobile_transport_invalid")
          requestBody = jsonRequestBody(body)
        }
        method == "DELETE" && sessionPath.matches(path) -> {
          val token = authorization?.removePrefix("DPoP ")
          if (token == authorization || token == null || token.length > 8_192 || !dpopPattern.matches(token) || dpop == null ||
            dpop.length > 8_192 || !dpopPattern.matches(dpop)
          ) throw MobileTransportFailure("mobile_transport_invalid")
          requestBody = jsonRequestBody(body)
        }
        else -> throw MobileTransportFailure("mobile_transport_invalid")
      }
      val request = Request.Builder()
        .url(base.newBuilder().encodedPath(path).build())
        .header("Accept", "application/json")
      if (authorization != null) request.header("Authorization", authorization)
      if (dpop != null) request.header("DPoP", dpop)
      return request.method(method, requestBody).build()
    }

    private fun decimalAtMost(value: String, maximum: String): Boolean =
      value.length < maximum.length || (value.length == maximum.length && value <= maximum)

    private fun allowedReadPath(pathWithQuery: String): Boolean {
      if (pathWithQuery == "/api/agentflow/me/agent-state" || sessionSnapshotPath.matches(pathWithQuery)) return true
      agentEventsPath.matchEntire(pathWithQuery)?.let {
        return decimalAtMost(it.groupValues[1], MAX_SAFE_SEQUENCE) && it.groupValues[2].toIntOrNull()?.let { limit -> limit in 1..200 } == true
      }
      agentSessionsPath.matchEntire(pathWithQuery)?.let {
        return it.groupValues[1].toIntOrNull()?.let { limit -> limit in 1..100 } == true
      }
      sessionEventsPath.matchEntire(pathWithQuery)?.let {
        return decimalAtMost(it.groupValues[1], MAX_SAFE_SEQUENCE) && it.groupValues[2].toIntOrNull()?.let { limit -> limit in 1..200 } == true
      }
      sessionMessagesPath.matchEntire(pathWithQuery)?.let {
        return decimalAtMost(it.groupValues[1], MAX_SAFE_SEQUENCE) && it.groupValues[2].toIntOrNull()?.let { limit -> limit in 1..20 } == true
      }
      return false
    }

    private fun buildReadRequest(origin: String, pathWithQuery: String, accessToken: String, dpop: String): Request {
      validatedOrigin(origin)
      if ('%' in pathWithQuery || '#' in pathWithQuery || '\\' in pathWithQuery || !allowedReadPath(pathWithQuery) ||
        accessToken.length > 8_192 || !dpopPattern.matches(accessToken) || dpop.length > 8_192 || !dpopPattern.matches(dpop)
      ) throw MobileTransportFailure("mobile_transport_invalid")
      val expected = origin + pathWithQuery
      val url = expected.toHttpUrlOrNull()
      if (url == null || url.toString() != expected) throw MobileTransportFailure("mobile_transport_invalid")
      return Request.Builder()
        .url(url)
        .header("Accept", "application/json")
        .header("Authorization", "DPoP $accessToken")
        .header("DPoP", dpop)
        .get()
        .build()
    }

    private fun safeVersion(value: StrictJsonValue?, allowMaximum: Boolean): Boolean {
      val number = (value as? StrictJsonValue.NumberValue)?.raw?.toBigDecimalOrNull() ?: return false
      return number >= BigDecimal.ONE && number.stripTrailingZeros().scale() <= 0 &&
        (if (allowMaximum) number <= maximumSafeVersion else number < maximumSafeVersion)
    }

    private fun validTurnBody(body: String, path: String, bytes: ByteArray): Boolean {
      if (bytes.size > MAX_TURN_REQUEST_BODY_BYTES) return false
      val fields = StrictJsonObject.parse(body) ?: return false
      if (path.endsWith("/turns")) {
        val required = setOf("input_text", "expected_state_version", "idempotency_key")
        if (fields.keys != required && fields.keys != required + "origin_id") return false
        val input = (fields["input_text"] as? StrictJsonValue.StringValue)?.value ?: return false
        val inputBytes = try { strictUtf8(input) } catch (_: MobileTransportFailure) { return false }
        val key = (fields["idempotency_key"] as? StrictJsonValue.StringValue)?.value ?: return false
        if (input.isEmpty() || inputBytes.size > 262_144 || !safeVersion(fields["expected_state_version"], false) || !stableAscii.matches(key)) return false
        val originId = fields["origin_id"]
        if (originId != null) {
          val value = (originId as? StrictJsonValue.StringValue)?.value ?: return false
          val count = value.codePointCount(0, value.length)
          if (count !in 1..128) return false
        }
        return true
      }
      if (!path.endsWith("/stop") || fields.keys != setOf("turn_id", "expected_state_version")) return false
      val turnId = (fields["turn_id"] as? StrictJsonValue.StringValue)?.value ?: return false
      return canonicalUuidPattern.matches(turnId) && safeVersion(fields["expected_state_version"], true)
    }

    private fun buildTurnRequest(origin: String, path: String, accessToken: String, dpop: String, body: String): Request {
      validatedOrigin(origin)
      if (!sessionTurnPath.matches(path) || '%' in path || '?' in path || '#' in path || '\\' in path ||
        accessToken.length > 8_192 || !dpopPattern.matches(accessToken) || dpop.length > 8_192 || !dpopPattern.matches(dpop)
      ) throw MobileTransportFailure("mobile_transport_invalid")
      val bytes = strictUtf8(body)
      if (!validTurnBody(body, path, bytes)) throw MobileTransportFailure("mobile_transport_invalid")
      val expected = origin + path
      val url = expected.toHttpUrlOrNull()
      if (url == null || url.toString() != expected) throw MobileTransportFailure("mobile_transport_invalid")
      return Request.Builder()
        .url(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Authorization", "DPoP $accessToken")
        .header("DPoP", dpop)
        .post(bytes.toRequestBody(JSON))
        .build()
    }

    private fun readResponse(response: Response, maximumBodyBytes: Int, invalidResponseCode: String): MobileTransportResponse {
      val status = response.code
      if (status !in 200..599 || status in 300..399) throw MobileTransportFailure(invalidResponseCode)
      val responseBody = response.body
      if (responseBody == null) return MobileTransportResponse(status, "")
      if (responseBody.contentLength() > maximumBodyBytes) throw MobileTransportFailure(invalidResponseCode)
      val input = responseBody.byteStream()
      val output = ByteArray(maximumBodyBytes + 1)
      var total = 0
      while (true) {
        val count = input.read(output, total, output.size - total)
        if (count < 0) break
        total += count
        if (total > maximumBodyBytes) throw MobileTransportFailure(invalidResponseCode)
      }
      return try {
        val decoder = StandardCharsets.UTF_8.newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
        MobileTransportResponse(status, decoder.decode(ByteBuffer.wrap(output, 0, total)).toString())
      } catch (_: Exception) {
        throw MobileTransportFailure(invalidResponseCode)
      }
    }
  }

  private data class TrackedRequest(var touchedAt: Long, var call: Call? = null, var cancelled: Boolean = false)
  private val trackingLock = Any()
  private val tracked = LinkedHashMap<String, TrackedRequest>()

  private fun pruneLocked(now: Long) {
    val iterator = tracked.iterator()
    while (iterator.hasNext()) {
      val entry = iterator.next()
      if (entry.value.call == null && now - entry.value.touchedAt >= RESERVATION_TTL_MILLIS) iterator.remove()
    }
    while (tracked.size >= MAX_TRACKED_REQUESTS) {
      val removable = tracked.entries.firstOrNull { it.value.call == null } ?: break
      tracked.remove(removable.key)
    }
  }

  fun newRequestId(): String = synchronized(trackingLock) {
    val now = System.currentTimeMillis()
    pruneLocked(now)
    if (tracked.size >= MAX_TRACKED_REQUESTS) throw MobileTransportFailure("mobile_transport_busy")
    var id: String
    do { id = UUID.randomUUID().toString() } while (tracked.containsKey(id))
    tracked[id] = TrackedRequest(now)
    id
  }

  fun request(
    requestId: String,
    origin: String,
    path: String,
    method: String,
    accessToken: String,
    body: String?,
    completion: (Result<MobileTransportResponse>) -> Unit
  ) {
    if (!isCanonicalUuid(requestId)) throw MobileTransportFailure("mobile_transport_invalid")
    // All validation and request construction happens before a Call is registered or enqueued.
    execute(requestId, client.newCall(buildRequest(origin, path, method, accessToken, body)), MAX_RESPONSE_BODY_BYTES, "mobile_transport_unavailable", completion)
  }

  fun sessionRequest(
    requestId: String,
    origin: String,
    path: String,
    method: String,
    authorization: String?,
    dpop: String?,
    body: String?,
    completion: (Result<MobileTransportResponse>) -> Unit
  ) {
    if (!isCanonicalUuid(requestId)) throw MobileTransportFailure("mobile_transport_invalid")
    execute(requestId, client.newCall(buildSessionRequest(origin, path, method, authorization, dpop, body)), MAX_RESPONSE_BODY_BYTES, "mobile_transport_unavailable", completion)
  }

  fun readRequest(
    requestId: String,
    origin: String,
    pathWithQuery: String,
    accessToken: String,
    dpop: String,
    completion: (Result<MobileTransportResponse>) -> Unit
  ) {
    if (!isCanonicalUuid(requestId)) throw MobileTransportFailure("mobile_transport_invalid")
    val maximumBodyBytes = if (sessionMessagesPath.matches(pathWithQuery)) MAX_MESSAGES_RESPONSE_BODY_BYTES else MAX_RESPONSE_BODY_BYTES
    execute(requestId, client.newCall(buildReadRequest(origin, pathWithQuery, accessToken, dpop)), maximumBodyBytes, "mobile_transport_response_invalid", completion)
  }

  fun turnRequest(
    requestId: String,
    origin: String,
    path: String,
    accessToken: String,
    dpop: String,
    body: String,
    completion: (Result<MobileTransportResponse>) -> Unit
  ) {
    if (!isCanonicalUuid(requestId)) throw MobileTransportFailure("mobile_transport_invalid")
    execute(requestId, client.newCall(buildTurnRequest(origin, path, accessToken, dpop, body)),
      MAX_RESPONSE_BODY_BYTES, "mobile_transport_response_invalid", completion)
  }

  private fun execute(
    requestId: String,
    call: Call,
    maximumResponseBodyBytes: Int,
    invalidResponseCode: String,
    completion: (Result<MobileTransportResponse>) -> Unit
  ) {
    synchronized(trackingLock) {
      val now = System.currentTimeMillis()
      pruneLocked(now)
      val existing = tracked[requestId] ?: throw MobileTransportFailure("mobile_transport_invalid")
      if (existing.cancelled) {
        tracked.remove(requestId)
        throw MobileTransportFailure("mobile_transport_unavailable")
      }
      if (existing.call != null) throw MobileTransportFailure("mobile_transport_busy")
      existing.touchedAt = now
      existing.call = call
    }
    try {
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, error: IOException) {
          synchronized(trackingLock) { if (tracked[requestId]?.call === call) tracked.remove(requestId) }
          completion(Result.failure(MobileTransportFailure("mobile_transport_unavailable")))
        }

        override fun onResponse(call: Call, response: Response) {
          val result = try {
            response.use { Result.success(readResponse(it, maximumResponseBodyBytes, invalidResponseCode)) }
          } catch (error: MobileTransportFailure) {
            Result.failure(error)
          } catch (_: Exception) {
            Result.failure(MobileTransportFailure("mobile_transport_unavailable"))
          }
          synchronized(trackingLock) { if (tracked[requestId]?.call === call) tracked.remove(requestId) }
          completion(result)
        }
      })
    } catch (_: Exception) {
      synchronized(trackingLock) { if (tracked[requestId]?.call === call) tracked.remove(requestId) }
      throw MobileTransportFailure("mobile_transport_unavailable")
    }
  }

  fun cancelRequest(requestId: String) {
    if (!isCanonicalUuid(requestId)) throw MobileTransportFailure("mobile_transport_invalid")
    val call = synchronized(trackingLock) {
      val now = System.currentTimeMillis()
      pruneLocked(now)
      val request = tracked[requestId] ?: throw MobileTransportFailure("mobile_transport_invalid")
      request.touchedAt = now
      request.cancelled = true
      request.call
    }
    call?.cancel()
  }

  fun cancelAll() {
    val calls = synchronized(trackingLock) {
      val values = tracked.values.mapNotNull { it.call }
      tracked.clear()
      values
    }
    calls.forEach { it.cancel() }
  }
}

private sealed class StrictJsonValue {
  data class ObjectValue(val fields: Map<String, StrictJsonValue>) : StrictJsonValue()
  data class StringValue(val value: String) : StrictJsonValue()
  data class NumberValue(val raw: String) : StrictJsonValue()
  object Other : StrictJsonValue()
}

/** Strict RFC 8259 parser that accepts one object and rejects duplicate decoded keys. */
private object StrictJsonObject {
  fun isValid(value: String): Boolean = parse(value) != null

  fun parse(value: String): Map<String, StrictJsonValue>? = try {
    Parser(value).parse()
  } catch (_: IllegalArgumentException) {
    null
  }

  private class Parser(private val source: String) {
    private var index = 0

    fun parse(): Map<String, StrictJsonValue>? {
      whitespace()
      if (peek() != '{') return null
      val result = jsonObject(0).fields
      whitespace()
      return if (index == source.length) result else null
    }

    private fun value(depth: Int): StrictJsonValue {
      if (depth > 64) fail()
      whitespace()
      return when (peek()) {
        '{' -> jsonObject(depth + 1)
        '[' -> { array(depth + 1); StrictJsonValue.Other }
        '"' -> StrictJsonValue.StringValue(string())
        't' -> { literal("true"); StrictJsonValue.Other }
        'f' -> { literal("false"); StrictJsonValue.Other }
        'n' -> { literal("null"); StrictJsonValue.Other }
        '-', in '0'..'9' -> StrictJsonValue.NumberValue(number())
        else -> fail()
      }
    }

    private fun jsonObject(depth: Int): StrictJsonValue.ObjectValue {
      take('{'); whitespace()
      val fields = LinkedHashMap<String, StrictJsonValue>()
      if (peek() == '}') { index++; return StrictJsonValue.ObjectValue(fields) }
      while (true) {
        if (peek() != '"') fail()
        val key = string()
        if (fields.containsKey(key)) fail()
        whitespace(); take(':'); fields[key] = value(depth); whitespace()
        when (peek()) {
          ',' -> { index++; whitespace() }
          '}' -> { index++; return StrictJsonValue.ObjectValue(fields) }
          else -> fail()
        }
      }
    }

    private fun array(depth: Int) {
      take('['); whitespace()
      if (peek() == ']') { index++; return }
      while (true) {
        value(depth); whitespace()
        when (peek()) {
          ',' -> { index++; whitespace() }
          ']' -> { index++; return }
          else -> fail()
        }
      }
    }

    private fun string(): String {
      take('"')
      val result = StringBuilder()
      while (index < source.length) {
        val char = source[index++]
        when {
          char == '"' -> return result.toString()
          char == '\\' -> appendEscape(result)
          char.code < 0x20 -> fail()
          char.isHighSurrogate() -> {
            if (index >= source.length || !source[index].isLowSurrogate()) fail()
            result.append(char).append(source[index++])
          }
          char.isLowSurrogate() -> fail()
          else -> result.append(char)
        }
      }
      fail()
    }

    private fun appendEscape(result: StringBuilder) {
      if (index >= source.length) fail()
      when (source[index++]) {
        '"' -> result.append('"')
        '\\' -> result.append('\\')
        '/' -> result.append('/')
        'b' -> result.append('\b')
        'f' -> result.append('\u000c')
        'n' -> result.append('\n')
        'r' -> result.append('\r')
        't' -> result.append('\t')
        'u' -> {
          val scalar = hexQuad()
          if (scalar in 0xd800..0xdbff) {
            if (index + 1 >= source.length || source[index++] != '\\' || source[index++] != 'u') fail()
            val low = hexQuad()
            if (low !in 0xdc00..0xdfff) fail()
            result.append(scalar.toChar()).append(low.toChar())
          } else {
            if (scalar in 0xdc00..0xdfff) fail()
            result.append(scalar.toChar())
          }
        }
        else -> fail()
      }
    }

    private fun hexQuad(): Int {
      var result = 0
      repeat(4) {
        if (index >= source.length) fail()
        val digit = source[index++].digitToIntOrNull(16) ?: fail()
        result = result * 16 + digit
      }
      return result
    }

    private fun number(): String {
      val start = index
      if (peek() == '-') index++
      when (peek()) {
        '0' -> index++
        in '1'..'9' -> while (peek() in '0'..'9') index++
        else -> fail()
      }
      if (peek() == '.') {
        index++
        if (peek() !in '0'..'9') fail()
        while (peek() in '0'..'9') index++
      }
      if (peek() == 'e' || peek() == 'E') {
        index++
        if (peek() == '+' || peek() == '-') index++
        if (peek() !in '0'..'9') fail()
        while (peek() in '0'..'9') index++
      }
      return source.substring(start, index)
    }

    private fun literal(expected: String) {
      if (!source.startsWith(expected, index)) fail()
      index += expected.length
    }

    private fun whitespace() { while (peek() == ' ' || peek() == '\n' || peek() == '\r' || peek() == '\t') index++ }
    private fun peek(): Char = if (index < source.length) source[index] else '\u0000'
    private fun take(expected: Char) { if (peek() != expected) fail(); index++ }
    private fun fail(): Nothing = throw IllegalArgumentException()
  }
}
