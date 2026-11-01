import XCTest

final class TabModelsTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    private func makeApi(_ t: FakeTransport) -> VirviApi {
        let store = MemoryStore()
        store.save(SecretKey.deviceId, "dev1"); store.save(SecretKey.headsetSecret, "s")
        t.on("/pass") { _ in (200, ["pass": "p", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: {})
        return VirviApi(baseUrl: base, transport: t, passes: passes)
    }

    private func scene(_ json: String) -> Props {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! Props
    }

    func testStreamsListVideosWithLiveLabels() async throws {
        let s = scene("""
        {"sk":"p1","name":"Main","videos":[{"sk":"v1","name":"Stage","isLive":true,"enableLiveStream":true},{"sk":"v2","isLive":false},{"name":"nosk"}],"images":[{"sk":"i1"}]}
        """)
        let rows = StreamModel.streams(scene: s)
        XCTAssertEqual(rows, [StreamRow(elementId: "v1", name: "Stage", isLive: true), StreamRow(elementId: "v2", name: "Screen", isLive: false)])
        XCTAssertEqual(rows.map { StreamModel.buttonLabel($0) }, ["Go Offline", "Go Live"])
        XCTAssertEqual(StreamModel.emptyCopy, "No active streams")
        XCTAssertTrue(StreamModel.streams(scene: scene("{}")).isEmpty)

        let t = FakeTransport()
        t.on("/api/elements/v2/live") { _ in (200, ["ok": true]) }
        try await StreamModel(api: makeApi(t), sceneId: "s1").setLive("v2", true)
        XCTAssertEqual(t.requests.last?.httpMethod, "POST")
        XCTAssertEqual(t.bodies("/api/elements/v2/live").first?["enabled"] as? Bool, true)
    }

    func testWorldsEmptyAndLoaded() async throws {
        XCTAssertEqual(WorldsModel.emptyCopy, "No connected worlds")
        let t = FakeTransport()
        t.script("/dcl/publish-status", [
            (200, ["destination": NSNull()]),
            (200, ["destination": ["id": "d1", "world": "my.dcl.eth", "mode": "sign", "status": "ready", "granted": false,
                                    "pending": 3, "publishUrl": "https://virvi.io/publish/?d=d1"]]),
        ])
        let m = WorldsModel(api: makeApi(t), sceneId: "s1")
        let none = try await m.load()
        XCTAssertNil(none)
        XCTAssertNil(m.destination)
        let row = try await m.load()
        XCTAssertEqual(row, WorldRow(world: "my.dcl.eth", status: "ready", pending: 3, publishUrl: "https://virvi.io/publish/?d=d1"))
        XCTAssertEqual(m.destination?.id, "d1", "feeds PlacedMessage's PublishDestination")
        XCTAssertTrue(placedMessage(name: "Rock", destination: m.destination).publish)
    }

    func testAlertsKeep20NewestFirstAndDiffLiveChanges() {
        let log = AlertsLog()
        XCTAssertEqual(AlertsLog.emptyCopy, "No notifications")
        for i in 1...25 { log.push("a\(i)", kind: i == 25 ? .error : .info) }
        XCTAssertEqual(log.entries.count, 20)
        XCTAssertEqual(log.entries.first?.text, "a25")
        XCTAssertEqual(log.entries.first?.kind, .error)
        XCTAssertEqual(log.entries.last?.text, "a6")

        let a = scene(#"{"videos":[{"sk":"v1","isLive":false},{"sk":"v2","isLive":true},{"sk":"v3","isLive":false}]}"#)
        let b = scene(#"{"videos":[{"sk":"v1","isLive":true},{"sk":"v2","isLive":false},{"sk":"v3"},{"sk":"v4","isLive":true}]}"#)
        XCTAssertEqual(AlertsLog.diff(prev: a, next: b), ["Stream is live", "Stream went offline"])
        XCTAssertEqual(AlertsLog.diff(prev: nil, next: b), [])
        XCTAssertEqual(AlertsLog.diff(prev: a, next: nil), [])
    }

    func testEventsSwitchLayoutPutsActivePreset() async throws {
        XCTAssertEqual(EventsModel.emptyCopy, "No active events")
        XCTAssertEqual(EventsModel.switchLabel, "Switch layout")
        let t = FakeTransport()
        t.on("/api/scenes/s1/events") { _ in (200, ["events": [
            ["id": "e1", "name": "Party", "startTime": "2026-11-01T10:00:00.000Z", "endTime": NSNull(), "live": true],
        ]]) }
        t.on("/api/scenes/s1") { r in
            r.httpMethod == "PUT" ? (200, ["scene": ["id": "s1"]])
                : (200, ["scene": ["activePresetId": "p1", "presets": [["id": "p1", "name": "Main"], ["id": "p2", "name": "Show"]]]])
        }
        let m = EventsModel(api: makeApi(t), sceneId: "s1")
        let events = try await m.load()
        XCTAssertEqual(events.map(\.name), ["Party"])
        XCTAssertTrue(events[0].live)
        XCTAssertNil(events[0].endTime)

        let s = scene(#"{"sk":"p1","name":"Main"}"#)
        XCTAssertEqual(EventsModel.presets(scene: s, loaded: nil), [PresetRow(id: "p1", name: "Main", active: true)])
        let loaded = try await m.loadPresets()
        XCTAssertEqual(EventsModel.presets(scene: s, loaded: loaded).map(\.active), [true, false])

        try await m.switchLayout("p2")
        XCTAssertEqual(t.requests.last?.httpMethod, "PUT")
        XCTAssertEqual(t.requests.last?.url?.path, "/api/scenes/s1")
        XCTAssertEqual(t.bodies("/api/scenes/s1").first?["activePresetId"] as? String, "p2")
    }

    func testRolesHasNoTransferHostAndShowsDashboardLine() async throws {
        XCTAssertEqual(RolesModel.transferLine, "To hand this scene to another host, use Roles on the dashboard.")
        XCTAssertEqual(RolesModel.roleLabel("cohost"), "Co-host")
        XCTAssertEqual(RolesModel.roleLabel("editor"), "Editor")
        XCTAssertEqual(RolesModel.roleLabel("viewer"), "Viewer")
        XCTAssertEqual(RolesModel.assignable, ["cohost", "editor", "viewer"])

        let t = FakeTransport()
        let w = "0x" + String(repeating: "ab", count: 20)
        t.on("/api/scenes/s1/roles") { r in
            r.httpMethod == "POST" ? (201, ["role": ["wallet": w, "role": "editor"]])
                : (200, ["host": ["wallets": ["0x" + String(repeating: "cd", count: 20)]],
                         "roles": [["wallet": w, "role": "cohost", "displayName": NSNull()]]])
        }
        t.on("/roles/\(w)") { _ in (204, nil) }
        let m = RolesModel(api: makeApi(t), sceneId: "s1")
        let list = try await m.load()
        XCTAssertEqual(list.hostWallets.count, 1)
        XCTAssertEqual(list.roles.first?.title, "0xabab…abab — Co-host")
        try await m.add(wallet: w, role: "editor")
        XCTAssertEqual(t.bodies("/api/scenes/s1/roles").first?["role"] as? String, "editor")
        try await m.remove(wallet: w)
        XCTAssertEqual(t.requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(t.count("/transfer-host"), 0)
    }
}
