import XCTest

@MainActor
final class DeviceAuthTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    private func make(_ t: FakeTransport, _ store: MemoryStore = MemoryStore()) -> (DeviceAuth, MemoryStore) {
        (DeviceAuth(baseUrl: base, transport: t, store: store, sleep: { _ in }), store)
    }

    private func pairStart(_ t: FakeTransport) {
        t.on("/api/ar/pair") { _ in (200, ["code": "ABC123", "approveUrl": "https://virvi.io/pair/headset/ABC123", "codeExpiresAt": iso(Date().addingTimeInterval(600))]) }
    }

    func testPairingStoresSecretInKeychainNotDefaults() async {
        let t = FakeTransport(); pairStart(t)
        let (auth, store) = make(t)
        await auth.startPairing()
        let secret = store.load("headsetSecret")
        XCTAssertEqual(secret?.count, 64)
        XCTAssertNil(UserDefaults.standard.object(forKey: "headsetSecret"))
        XCTAssertNil(UserDefaults.standard.object(forKey: "deviceId"))
        let body = t.bodies("/api/ar/pair").first
        XCTAssertEqual(body?["secretHash"] as? String, sha256Hex(secret ?? ""))
        XCTAssertEqual(body?["deviceName"] as? String, "Apple Vision Pro")
        XCTAssertEqual(auth.state, .pairing(code: "ABC123", approveUrl: URL(string: "https://virvi.io/pair/headset/ABC123")!))
    }

    func testPairingOfflineShowsTheOfflineCopyUntilARetryWorks() async {
        let t = FakeTransport()
        let calls = Counter()
        t.on("/api/ar/pair") { _ in
            if calls.next() == 0 { throw URLError(.notConnectedToInternet) }
            return (200, ["code": "ABC123", "approveUrl": "https://virvi.io/pair/headset/ABC123", "codeExpiresAt": iso(Date().addingTimeInterval(600))])
        }
        let (auth, store) = make(t)
        await auth.startPairing() // first launch, offline
        XCTAssertEqual(auth.state, .unpaired)
        XCTAssertEqual(auth.pairingMessage, "Can't reach virvi.io: check the connection and try again")
        XCTAssertNil(store.load("headsetSecret"))
        await auth.startPairing() // back online
        XCTAssertNil(auth.pairingMessage)
        XCTAssertEqual(auth.state, .pairing(code: "ABC123", approveUrl: URL(string: "https://virvi.io/pair/headset/ABC123")!))
    }

    func testPairingFailingOnlineShowsNoOfflineCopy() async {
        let t = FakeTransport()
        t.on("/api/ar/pair") { _ in (500, ["error": "boom"]) }
        let (auth, _) = make(t)
        await auth.startPairing()
        XCTAssertEqual(auth.state, .unpaired)
        XCTAssertNil(auth.pairingMessage)
    }

    func testClaimApprovedStoresDeviceId() async {
        let t = FakeTransport(); pairStart(t)
        t.script("/claim", [(200, ["status": "pending"]), (200, ["status": "approved", "deviceId": "dev1", "kind": "personal", "expiresAt": iso(Date())])])
        let (auth, store) = make(t)
        await auth.startPairing()
        await auth.pollClaim()
        XCTAssertEqual(auth.state, .paired(deviceId: "dev1"))
        XCTAssertEqual(store.load("deviceId"), "dev1")
        XCTAssertEqual(t.count("/claim"), 2)
    }

    func testClaimRefusedSetsRefused() async {
        let t = FakeTransport(); pairStart(t)
        t.script("/claim", [(200, ["status": "refused"])])
        let (auth, store) = make(t)
        await auth.startPairing()
        await auth.pollClaim()
        XCTAssertEqual(auth.state, .refused)
        XCTAssertNil(store.load("headsetSecret"))
    }

    func testRevokedDeviceReturnsToUnpaired() async {
        let t = FakeTransport()
        t.script("/pass", [(401, ["error": "device_revoked"])])
        let store = MemoryStore()
        store.save("headsetSecret", "s"); store.save("deviceId", "dev1")
        let (auth, _) = make(t, store)
        auth.restore()
        XCTAssertEqual(auth.state, .paired(deviceId: "dev1"))
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: { await auth.onRevoked() })
        let api = VirviApi(baseUrl: base, transport: t, passes: passes)
        do {
            let _: EmptyResponse = try await api.scene("s1", "GET", "/api/x", body: nil)
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .status(401, code: "device_revoked"))
        }
        XCTAssertEqual(auth.state, .unpaired)
        XCTAssertNil(store.load("headsetSecret"))
        XCTAssertNil(store.load("deviceId"))
        XCTAssertLessThanOrEqual(t.count("/pass"), 1)
    }

    func testSignOutEndsSessionAndClearsKeys() async {
        let t = FakeTransport()
        t.on("/end") { _ in (204, nil) }
        let store = MemoryStore()
        store.save("headsetSecret", "s"); store.save("deviceId", "dev1")
        let (auth, _) = make(t, store)
        auth.restore()
        await auth.signOut()
        XCTAssertEqual(t.count("/api/ar/devices/dev1/end"), 1)
        XCTAssertNil(store.load("headsetSecret"))
        XCTAssertEqual(auth.state, .unpaired)
    }

    func testRevokeSeenOnSceneCallReturnsToUnpaired() async throws {
        let t = FakeTransport()
        t.on("/pass") { _ in (200, ["pass": "p1", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
        t.on("/api/thing") { _ in (401, ["error": "device_revoked"]) }
        let store = MemoryStore()
        store.save("headsetSecret", "s"); store.save("deviceId", "dev1")
        let (auth, _) = make(t, store)
        auth.restore()
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: { await auth.onRevoked() })
        let api = VirviApi(baseUrl: base, transport: t, passes: passes)
        _ = try await passes.pass(for: "s1") // a valid pass is already cached
        do {
            let _: EmptyResponse = try await api.scene("s1", "GET", "/api/thing", body: nil)
            XCTFail("expected throw")
        } catch {
            XCTAssertEqual(error as? ApiError, .status(401, code: "device_revoked"))
        }
        XCTAssertEqual(auth.state, .unpaired)
        XCTAssertNil(store.load("headsetSecret"))
        XCTAssertNil(store.load("deviceId"))
        XCTAssertEqual(t.count("/api/thing"), 1)
        XCTAssertEqual(t.count("/pass"), 1)
    }

    func testStaleClaimResponseDoesNotOverwriteCancel() async {
        let fake = FakeTransport(); pairStart(fake)
        fake.script("/claim", [(200, ["status": "approved", "deviceId": "dev1", "kind": "personal", "expiresAt": iso(Date())])])
        let gate = GatedTransport(fake, gating: "/claim")
        let store = MemoryStore()
        let auth = DeviceAuth(baseUrl: base, transport: gate, store: store, sleep: { _ in })
        await auth.startPairing()
        let poll = Task { await auth.pollClaim() }
        await gate.waitUntilEntered()
        auth.cancel()
        await gate.open()
        await poll.value
        XCTAssertEqual(auth.state, .unpaired)
        XCTAssertNil(store.load("deviceId"))
        XCTAssertNil(store.load("headsetSecret"))
    }

    func testFormatPairingCode() {
        XCTAssertEqual(formatPairingCode("ABC123"), "ABC-123")
        XCTAssertEqual(formatPairingCode("abc-123"), "ABC-123")
        XCTAssertEqual(formatPairingCode("AB"), "AB")
    }

    /// The approval address to type in, since a QR shown inside the headset can't be scanned.
    func testPairingAddressIsShortAndTypeable() {
        XCTAssertEqual(pairingAddress(URL(string: "https://virvi.io/pair/headset/ABC123")!), "virvi.io/pair/headset/ABC123")
        XCTAssertEqual(pairingAddress(URL(string: "https://www.virvi.io/pair/headset/ABC123?x=1")!), "virvi.io/pair/headset/ABC123")
        XCTAssertEqual(pairingAddress(URL(string: "http://localhost:3000/pair/headset/X")!), "localhost:3000/pair/headset/X")
    }
}
