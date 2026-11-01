import XCTest

@MainActor
final class EditSessionTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    /// A manual clock and scheduler for the draft throttle.
    @MainActor final class Clock {
        var t: TimeInterval = 1000
        var scheduled: [(at: TimeInterval, run: @MainActor () -> Void)] = []
        func advance(_ s: TimeInterval) { t += s }
        /// Runs everything due.
        func fire() {
            let due = scheduled.filter { $0.at <= t }
            scheduled.removeAll { $0.at <= t }
            due.forEach { $0.run() }
        }
    }

    private struct Rig {
        let session: EditSession
        let transport: FakeTransport
        let clock: Clock
    }

    private func rig(setup: (FakeTransport) -> Void = { _ in }, gate: String? = nil) -> (Rig, GatedTransport?) {
        let t = FakeTransport()
        setup(t) // first match wins, so a test's own routes go before the defaults
        t.on("/pass") { _ in (200, ["pass": "p", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
        t.on("/api/ar/drafts") { _ in (204, nil) }
        t.on("/api/ar/drafts/end") { _ in (204, nil) }
        t.on("/api/instances/i1") { _ in (200, ["instance": [:]]) }
        let gated = gate.map { GatedTransport(t, gating: $0) }
        let transport: HttpTransport = gated ?? t
        let store = MemoryStore()
        store.save(SecretKey.deviceId, "dev1"); store.save(SecretKey.headsetSecret, "s")
        let passes = PassProvider(baseUrl: base, transport: transport, secrets: store, onRevoked: {})
        let api = VirviApi(baseUrl: base, transport: transport, passes: passes)
        let clock = Clock()
        let session = EditSession(api: api, sceneId: "s1", now: { clock.t }, schedule: { delay, run in
            clock.scheduled.append((clock.t + delay, run))
        })
        return (Rig(session: session, transport: t, clock: clock), gated)
    }

    private let start = ItemTransform(position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1])
    private func selection(_ sk: String = "i1", name: String = "Crate") -> Selection {
        Selection(elementId: "e1", sk: sk, name: name, kind: "model", transform: start)
    }

    func testSaveRevertOffUntilChange() {
        let (r, _) = rig(); let s = r.session
        XCTAssertTrue(s.select(selection()))
        XCTAssertFalse(s.saveEnabled); XCTAssertFalse(s.revertEnabled)
        var t = start; t.position.x = 3
        s.update(t)
        XCTAssertTrue(s.dirty); XCTAssertTrue(s.saveEnabled); XCTAssertTrue(s.revertEnabled)
    }

    func testSelectingAnotherWhileDirtyIsRefusedWithCopy() {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        XCTAssertFalse(s.select(selection("i2", name: "Lamp")))
        XCTAssertEqual(s.message, "Save or revert changes to Crate first.")
        XCTAssertEqual(s.selected?.sk, "i1")
    }

    func testDoneWhileDirtyRefusedWithCopy() {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        XCTAssertTrue(s.done())
        XCTAssertNil(s.selected)
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        XCTAssertFalse(s.done())
        XCTAssertEqual(s.message, "Save or revert changes to Crate first.")
        XCTAssertNotNil(s.selected)
    }

    func testSnapSteps() {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        s.snap = true
        var t = start; t.rotation = [0, 22, 0]
        s.update(t)
        XCTAssertEqual(s.selected?.current.rotation.y ?? -1, 15, accuracy: 1e-9)
        t = start; t.scale = [1.23, 1.23, 1.23]
        s.update(t)
        XCTAssertEqual(s.selected!.current.scale.x, 1.2, accuracy: 1e-9)
        XCTAssertEqual(s.selected!.current.scale.z, 1.2, accuracy: 1e-9)
        t = start; t.scale = [1.37, 1, 1]
        s.update(t)
        XCTAssertEqual(s.selected!.current.scale.x, 1.25, accuracy: 1e-9)
        XCTAssertEqual(s.selected!.current.scale.y, 1, accuracy: 1e-9)
        // Move is never snapped.
        t = start; t.position = [1.234, 0, 2.345]
        s.update(t)
        XCTAssertEqual(s.selected!.current.position, [1.234, 0, 2.345])
        // Snap off: untouched.
        s.snap = false
        t = start; t.rotation = [0, 22, 0]
        s.update(t)
        XCTAssertEqual(s.selected!.current.rotation.y, 22)
    }

    func testLockCycles() {
        XCTAssertEqual(AxisLock.free.next(), .x)
        XCTAssertEqual(AxisLock.x.next(), .y)
        XCTAssertEqual(AxisLock.y.next(), .z)
        XCTAssertEqual(AxisLock.z.next(), .free)
        let (r, _) = rig()
        r.session.cycleLock()
        XCTAssertEqual(r.session.lock, .x)
    }

    func testExactSetsFieldForMode() {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        s.exact(.position, [5, 6, 7])
        XCTAssertEqual(s.selected?.current.position, [5, 6, 7])
        s.exact(.rotation, [0, 90, 0])
        XCTAssertEqual(s.selected?.current.rotation, [0, 90, 0])
        s.exact(.scale, [2, 2, 2])
        XCTAssertEqual(s.selected?.current.scale, [2, 2, 2])
        XCTAssertTrue(s.dirty)
    }

    func testDraftsThrottledTo100ms() async {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        for i in 1...10 {
            var t = start; t.position.x = Double(i)
            s.update(t)
            r.clock.advance(0.005)
        }
        await s.idle()
        XCTAssertEqual(r.transport.count("/api/ar/drafts"), 1)
        r.clock.advance(0.1)
        r.clock.fire()
        await s.idle()
        let drafts = r.transport.bodies("/api/ar/drafts")
        XCTAssertEqual(drafts.count, 2)
        XCTAssertEqual(drafts[0]["element"] as? String, "model")
        XCTAssertEqual(drafts[0]["sk"] as? String, "i1")
        let last = drafts[1]["position"] as? [String: Double]
        XCTAssertEqual(last?["x"], 10) // the trailing draft is the latest
    }

    func testSaveSendsPutThenDraftEndSaved() async {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        await s.save()
        let paths = r.transport.requests.map { $0.url!.path }.filter { $0.contains("/api/") && !$0.hasSuffix("/pass") }
        XCTAssertEqual(paths.suffix(2), ["/api/instances/i1", "/api/ar/drafts/end"])
        let put = r.transport.requests.first { $0.url!.path == "/api/instances/i1" }!
        XCTAssertEqual(put.httpMethod, "PUT")
        let body = try! JSONSerialization.jsonObject(with: put.httpBody!) as! [String: Any]
        XCTAssertEqual((body["position"] as? [String: Double])?["x"], 3)
        XCTAssertEqual(r.transport.bodies("/api/ar/drafts/end").last?["saved"] as? Bool, true)
        XCTAssertFalse(s.dirty); XCTAssertEqual(s.selected?.original.position.x, 3)
        XCTAssertFalse(s.saving)
        XCTAssertTrue(s.editingKeys.isEmpty)
    }

    func testSaveWaitsForTheAnswer() async {
        let (r, gated) = rig(gate: "/api/instances/i1"); let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        let saving = Task { await s.save() }
        await gated!.waitUntilEntered()
        XCTAssertTrue(s.saving); XCTAssertFalse(s.saveEnabled); XCTAssertFalse(s.revertEnabled)
        XCTAssertEqual(r.transport.count("/api/ar/drafts/end"), 0)
        XCTAssertTrue(s.dirty)
        await gated!.open()
        await saving.value
        XCTAssertFalse(s.dirty)
        XCTAssertEqual(r.transport.count("/api/ar/drafts/end"), 1)
    }

    func testRevertSendsDraftEndNotSaved() async {
        let (r, _) = rig(); let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        s.revert()
        await s.idle()
        XCTAssertFalse(s.dirty)
        XCTAssertEqual(s.selected?.current, start)
        XCTAssertEqual(r.transport.bodies("/api/ar/drafts/end").last?["saved"] as? Bool, false)
        XCTAssertEqual(r.transport.count("/api/instances/i1"), 0)
        XCTAssertTrue(s.editingKeys.isEmpty)
    }

    func testFeedUpdateDoesNotMoveItemBeingEdited() async {
        let (r, _) = rig(); let s = r.session
        XCTAssertTrue(s.editingKeys.isEmpty)
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        XCTAssertEqual(s.editingKeys, ["e1:i1"]) // the renderer's item key: "<element sk>:<instance sk>"
        await s.save()
        XCTAssertTrue(s.editingKeys.isEmpty)
        s.update(t.with(x: 9))
        XCTAssertEqual(s.editingKeys, ["e1:i1"])
        s.revert()
        XCTAssertTrue(s.editingKeys.isEmpty)
    }

    func testHeldItemStopsDraftingAndBlocksSave() async {
        let (r, _) = rig(setup: { $0.on("/api/ar/drafts") { _ in (409, ["error": "held", "holderName": "Sam (headset)"]) } })
        let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        await s.idle()
        XCTAssertEqual(s.heldBy, "Sam (headset)")
        XCTAssertEqual(s.message, "being moved by Sam (headset)")
        XCTAssertFalse(s.saveEnabled)
        XCTAssertTrue(s.revertEnabled)
        r.clock.advance(1)
        s.update(t.with(x: 4)); r.clock.advance(1); r.clock.fire()
        await s.idle()
        XCTAssertEqual(r.transport.count("/api/ar/drafts"), 1) // no more drafts
        await s.save()
        XCTAssertEqual(r.transport.count("/api/instances/i1"), 0)
        // Reselecting resumes drafting.
        s.revert()
        await s.idle()
        _ = s.select(selection())
        XCTAssertNil(s.heldBy)
    }

    func testOfflineSaveKeepsDraftAndShowsCopy() async {
        let (r, _) = rig(setup: { $0.on("/api/instances/i1") { _ in throw URLError(.notConnectedToInternet) } })
        let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        await s.save()
        XCTAssertEqual(s.message, "Can't reach virvi.io: check the connection and try again")
        XCTAssertTrue(s.dirty)
        XCTAssertFalse(s.saving)
        XCTAssertTrue(s.saveEnabled)
        XCTAssertEqual(s.selected?.current.position.x, 3)
        XCTAssertEqual(r.transport.count("/api/ar/drafts/end"), 0)
        XCTAssertEqual(s.editingKeys, ["e1:i1"])
    }

    func testRevokedDeviceDropsSelectionQuietly() async {
        let (r, _) = rig(setup: {
            $0.on("/api/instances/i1") { _ in (401, ["error": "device_revoked"]) }
        })
        let s = r.session
        _ = s.select(selection())
        var t = start; t.position.x = 3
        s.update(t)
        await s.save()
        XCTAssertNil(s.selected)
        XCTAssertFalse(s.dirty); XCTAssertFalse(s.saving)
        XCTAssertNil(s.message)
        XCTAssertTrue(s.editingKeys.isEmpty)
    }
}

private extension ItemTransform {
    func with(x: Double) -> ItemTransform { var t = self; t.position.x = x; return t }
}
