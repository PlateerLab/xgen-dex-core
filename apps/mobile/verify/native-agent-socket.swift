import Foundation

private enum VerificationFailure: Error { case failed(String) }

@main
struct NativeAgentSocketVerification {
  static func main() throws {
    guard CommandLine.arguments.count == 3 else {
      throw VerificationFailure.failed("expected HTTPS origin and fixture certificate")
    }
    let origin = CommandLine.arguments[1]
    let certificate = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    let sessionId = "00000000-0000-4000-8000-000000000001"
    let accessToken = "fixture.access.token"
    let dpop = "fixture.header.signature"

    func wait<T>(_ label: String, timeout: TimeInterval = 12,
      _ start: (@escaping (Result<T, NativeSocketFailure>) -> Void) throws -> Void) throws -> Result<T, NativeSocketFailure> {
      let semaphore = DispatchSemaphore(value: 0)
      var result: Result<T, NativeSocketFailure>?
      try start { value in result = value; semaphore.signal() }
      guard semaphore.wait(timeout: .now() + timeout) == .success, let result else {
        throw VerificationFailure.failed("\(label) timeout")
      }
      return result
    }

    func expect(_ expected: NativeSocketFailure, _ result: Result<Void, NativeSocketFailure>, _ label: String) throws {
      guard case .failure(expected) = result else { throw VerificationFailure.failed(label) }
    }

    func open(_ transport: NativeAgentSocket, _ sequence: String) throws -> String {
      let id = try transport.newSocketId()
      let result = try wait("open \(sequence)") { completion in
        try transport.openAgentSocket(socketId: id, origin: origin, sessionId: sessionId,
          afterSequence: sequence, accessToken: accessToken, dpop: dpop, completion: completion)
      }
      try result.get()
      return id
    }

    func close(_ transport: NativeAgentSocket, _ id: String) throws {
      try wait("close") { completion in
        try transport.closeAgentSocket(socketId: id, completion: completion)
      }.get()
    }

    let validation = NativeAgentSocket(fixtureCertificate: certificate)
    let reserved = try validation.newSocketId()
    try close(validation, reserved)
    try close(validation, reserved)
    do {
      _ = try wait("reuse") { completion in
        try validation.openAgentSocket(socketId: reserved, origin: origin, sessionId: sessionId,
          afterSequence: "0", accessToken: accessToken, dpop: dpop, completion: completion)
      }
      throw VerificationFailure.failed("cancelled reservation reused")
    } catch NativeSocketFailure.invalid {}

    for invalidOrigin in [origin + "/", origin.replacingOccurrences(of: "https://", with: "http://"), "https://LOCALHOST"] {
      let id = try validation.newSocketId()
      do {
        try validation.openAgentSocket(socketId: id, origin: invalidOrigin, sessionId: sessionId,
          afterSequence: "0", accessToken: accessToken, dpop: dpop) { _ in }
        throw VerificationFailure.failed("invalid origin accepted")
      } catch NativeSocketFailure.invalid {}
      try close(validation, id)
    }
    for sequence in ["", "00", "01", "-1", "9007199254740992"] {
      let id = try validation.newSocketId()
      do {
        try validation.openAgentSocket(socketId: id, origin: origin, sessionId: sessionId,
          afterSequence: sequence, accessToken: accessToken, dpop: dpop) { _ in }
        throw VerificationFailure.failed("invalid cursor accepted")
      } catch NativeSocketFailure.invalid {}
      try close(validation, id)
    }
    let badSession = try validation.newSocketId()
    do {
      try validation.openAgentSocket(socketId: badSession, origin: origin,
        sessionId: "00000000-0000-0000-0000-000000000001", afterSequence: "0",
        accessToken: accessToken, dpop: dpop) { _ in }
      throw VerificationFailure.failed("non-versioned session accepted")
    } catch NativeSocketFailure.invalid {}
    try close(validation, badSession)
    let badJWT = try validation.newSocketId()
    do {
      try validation.openAgentSocket(socketId: badJWT, origin: origin, sessionId: sessionId,
        afterSequence: "0", accessToken: "bad\ntoken", dpop: dpop) { _ in }
      throw VerificationFailure.failed("invalid JWT accepted")
    } catch NativeSocketFailure.invalid {}
    try close(validation, badJWT)

    let capacity = NativeAgentSocket(fixtureCertificate: certificate)
    var capacityIDs: [String] = []
    for _ in 0..<64 { capacityIDs.append(try capacity.newSocketId()) }
    do { _ = try capacity.newSocketId(); throw VerificationFailure.failed("reservation cap ignored") }
    catch NativeSocketFailure.busy {}
    for id in capacityIDs { try close(capacity, id) }
    let recycledID = try capacity.newSocketId()
    try close(capacity, recycledID)

    let transport = NativeAgentSocket(fixtureCertificate: certificate)
    let eventID = try open(transport, "0")
    let event = try wait("event") { completion in
      try transport.nextAgentSocket(socketId: eventID, completion: completion)
    }.get()
    guard event.type == "events", event.text == "{\"sequence\":1}" else {
      throw VerificationFailure.failed("event envelope")
    }
    try close(transport, eventID)
    try close(transport, eventID)

    let concurrentID = try open(transport, "12")
    let firstSemaphore = DispatchSemaphore(value: 0)
    var first: Result<MobileSocketEvent, NativeSocketFailure>?
    try transport.nextAgentSocket(socketId: concurrentID) { first = $0; firstSemaphore.signal() }
    do {
      try transport.nextAgentSocket(socketId: concurrentID) { _ in }
      throw VerificationFailure.failed("concurrent next accepted")
    } catch NativeSocketFailure.busy {}
    guard firstSemaphore.wait(timeout: .now() + 2) == .success,
      try first?.get().text == "{\"sequence\":12}" else { throw VerificationFailure.failed("first next") }
    try close(transport, concurrentID)

    for (sequence, expected) in [("3", NativeSocketFailure.authentication), ("16", .authentication),
      ("4", .cursorConflict), ("5", .unavailable), ("21", .unavailable),
      ("22", .unavailable), ("23", .unavailable), ("6", .invalid)] {
      let id = try transport.newSocketId()
      let result = try wait("HTTP \(sequence)") { completion in
        try transport.openAgentSocket(socketId: id, origin: origin, sessionId: sessionId,
          afterSequence: sequence, accessToken: accessToken, dpop: dpop, completion: completion)
      }
      try expect(expected, result, "HTTP failure mapping \(sequence)")
      let blocked = try transport.newSocketId()
      do {
        try transport.openAgentSocket(socketId: blocked, origin: origin, sessionId: sessionId,
          afterSequence: "0", accessToken: accessToken, dpop: dpop) { _ in }
        throw VerificationFailure.failed("terminal origin latch released early")
      } catch NativeSocketFailure.busy {}
      try close(transport, blocked)
      try close(transport, id)
    }

    for (sequence, expected) in [("7", NativeSocketFailure.authentication),
      ("8", .cursorConflict), ("9", .unavailable), ("18", .unavailable),
      ("19", .authentication), ("20", .authentication), ("17", .unavailable)] {
      let id = try open(transport, sequence)
      Thread.sleep(forTimeInterval: 0.15)
      let result = try wait("close \(sequence)") { completion in
        try transport.nextAgentSocket(socketId: id, completion: completion)
      }
      guard case .failure(expected) = result else { throw VerificationFailure.failed("close mapping \(sequence)") }
      try close(transport, id)
    }

    for sequence in ["24", "25", "26", "27", "28"] {
      let protocolID = try open(transport, sequence)
      Thread.sleep(forTimeInterval: 0.15)
      let protocolResult = try wait("invalid close \(sequence)") { completion in
        try transport.nextAgentSocket(socketId: protocolID, completion: completion)
      }
      guard case .failure(.invalid) = protocolResult else {
        throw VerificationFailure.failed("invalid close mapping \(sequence)")
      }
      try close(transport, protocolID)
    }

    for sequence in ["1", "2", "14"] {
      let id = try open(transport, sequence)
      let result = try wait("invalid frame \(sequence)") { completion in
        try transport.nextAgentSocket(socketId: id, completion: completion)
      }
      guard case .failure(.invalid) = result else { throw VerificationFailure.failed("invalid frame \(sequence)") }
      try close(transport, id)
    }
    let maximumID = try open(transport, "15")
    let maximum = try wait("maximum frame") { completion in
      try transport.nextAgentSocket(socketId: maximumID, completion: completion)
    }.get()
    guard maximum.text.utf8.count == 1_048_576 else { throw VerificationFailure.failed("maximum frame") }
    try close(transport, maximumID)

    let cancelBeforeID = try transport.newSocketId()
    let openSemaphore = DispatchSemaphore(value: 0)
    var cancelledOpen: Result<Void, NativeSocketFailure>?
    var cancelledOpenCount = 0
    try transport.openAgentSocket(socketId: cancelBeforeID, origin: origin, sessionId: sessionId,
      afterSequence: "10", accessToken: accessToken, dpop: dpop) {
        cancelledOpenCount += 1
        cancelledOpen = $0
        openSemaphore.signal()
      }
    let cancelStarted = Date()
    try close(transport, cancelBeforeID)
    guard Date().timeIntervalSince(cancelStarted) < 2,
      openSemaphore.wait(timeout: .now() + 1) == .success,
      case .failure(.unavailable) = cancelledOpen else { throw VerificationFailure.failed("cancel before open") }
    try close(transport, cancelBeforeID)

    let cancelAfterID = try open(transport, "11")
    try close(transport, cancelAfterID)
    Thread.sleep(forTimeInterval: 3.2)
    guard cancelledOpenCount == 1 else { throw VerificationFailure.failed("late open completed twice") }

    let closingID = try open(transport, "13")
    let closingSemaphore = DispatchSemaphore(value: 0)
    try transport.closeAgentSocket(socketId: closingID) { result in
      if case .failure = result { return }
      closingSemaphore.signal()
    }
    if closingSemaphore.wait(timeout: .now()) == .timedOut {
      let duplicateID = try transport.newSocketId()
      let duplicateOpenSemaphore = DispatchSemaphore(value: 0)
      var duplicateOpen: Result<Void, NativeSocketFailure>?
      var rejectedWhileClosing = false
      do {
        try transport.openAgentSocket(socketId: duplicateID, origin: origin, sessionId: sessionId,
          afterSequence: "0", accessToken: accessToken, dpop: dpop) {
            duplicateOpen = $0
            duplicateOpenSemaphore.signal()
          }
      } catch NativeSocketFailure.busy { rejectedWhileClosing = true }
      if rejectedWhileClosing {
        try close(transport, duplicateID)
        guard closingSemaphore.wait(timeout: .now() + 3) == .success else {
          throw VerificationFailure.failed("closing acknowledgement")
        }
      } else {
        guard closingSemaphore.wait(timeout: .now()) == .success else {
          throw VerificationFailure.failed("closing origin reused before acknowledgement")
        }
        guard duplicateOpenSemaphore.wait(timeout: .now() + 3) == .success else {
          throw VerificationFailure.failed("post-close reuse did not open")
        }
        try duplicateOpen?.get()
        try close(transport, duplicateID)
      }
    }

    let teardownID = try open(transport, "11")
    _ = teardownID
    transport.closeAll()
    Thread.sleep(forTimeInterval: 0.5)
    do { _ = try transport.newSocketId(); throw VerificationFailure.failed("disposed manager accepted request") }
    catch NativeSocketFailure.unavailable {}

    print("native agent WebSocket verification passed")
  }
}
