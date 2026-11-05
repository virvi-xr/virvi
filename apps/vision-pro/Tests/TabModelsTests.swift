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
        XCTAssertEqual(rows, [StreamRow(elementId: "v1", name: "Stage", isLive: true, offImageSrc: ""), StreamRow(elementId: "v2", name: "Screen", isLive: false, offImageSrc: "")])
        XCTAssertEqual(rows.map { StreamModel.buttonLabel($0) }, ["Go Offline", "Go Live"])
        XCTAssertEqual(StreamModel.emptyCopy, "No active streams")
        XCTAssertTrue(StreamModel.streams(scene: scene("{}")).isEmpty)

        let t = FakeTransport()
        t.on("/api/elements/v2/live") { _ in (200, ["ok": true]) }
        try await StreamModel(api: makeApi(t), sceneId: "s1").setLive("v2", true)
        XCTAssertEqual(t.requests.last?.httpMethod, "POST")
        XCTAssertEqual(t.bodies("/api/elements/v2/live").first?["enabled"] as? Bool, true)
    }

    // MARK: Off image (LIV-54)

    private func lib(_ id: String, _ name: String, _ url: String, type: String?, kind: String = "media", status: String = "ready") -> LibraryItem {
        LibraryItem(id: id, kind: kind, name: name, url: url, contentType: type, status: status, error: nil)
    }

    func testStreamRowsCarryTheScreensOffImage() {
        let rows = StreamModel.streams(scene: scene(#"{"videos":[{"sk":"v1","name":"Stage","offImageSrc":" https://x/poster.png "}]}"#))
        XCTAssertEqual(rows.first?.offImageSrc, "https://x/poster.png")
    }

    func testOffImageChoicesAreTheLibrarysReadyImages() {
        let choices = StreamModel.offImageChoices([
            lib("a", "Poster", "https://x/p.png", type: "image/png"),
            lib("b", "Loop", "https://x/v.mp4", type: "video/mp4"),
            lib("c", "Busy", "https://x/c.jpg", type: "image/jpeg", status: "processing"),
            lib("d", "Chair", "https://x/m.glb", type: "model/gltf-binary", kind: "model"),
            lib("e", "Anim", "https://x/e.gif", type: "image/gif"),
            lib("f", "Heic", "https://x/f.heic", type: "image/heic"),
        ])
        XCTAssertEqual(choices, [OffImageChoice(id: "a", name: "Poster", url: "https://x/p.png"), OffImageChoice(id: "e", name: "Anim", url: "https://x/e.gif")])
    }

    func testOffImageLabelNamesItByItsLibraryName() {
        let images = [OffImageChoice(id: "a", name: "Poster", url: "https://x/p.png")]
        let row = { (src: String) in StreamRow(elementId: "v", name: "S", isLive: false, offImageSrc: src) }
        XCTAssertEqual(StreamModel.offImageLabel(row("https://x/p.png"), images), "Off image: Poster")
        XCTAssertEqual(StreamModel.offImageLabel(row("https://elsewhere/q.png"), images), "Off image: from a link")
        XCTAssertEqual(StreamModel.offImageLabel(row(""), images), "No off image")
    }

    func testSetOffImageKeepsTheScreensOtherProperties() async throws {
        let t = FakeTransport()
        t.on("/api/scenes/s1") { _ in (200, ["scene": ["presets": [["elements": [
            ["id": "v1", "properties": ["offType": 1, "playlist": ["https://x/a.mp4"], "offImageSrc": "https://x/old.png"]],
        ]]]]]) }
        t.on("/api/elements/v1") { _ in (200, ["element": ["id": "v1"]]) }
        let model = StreamModel(api: makeApi(t), sceneId: "s1")
        try await model.setOffImage("v1", "https://x/p.png")
        let put = try XCTUnwrap(t.bodies("/api/elements/v1").last?["properties"] as? [String: Any])
        XCTAssertEqual(put["offImageSrc"] as? String, "https://x/p.png")
        XCTAssertEqual(put["offType"] as? Int, 1)
        XCTAssertEqual(put["playlist"] as? [String], ["https://x/a.mp4"])
        XCTAssertEqual(t.requests.last?.httpMethod, "PUT")
        // Cleared as '' rather than dropped, so the change reaches the world
        try await model.setOffImage("v1", "")
        XCTAssertEqual((t.bodies("/api/elements/v1").last?["properties"] as? [String: Any])?["offImageSrc"] as? String, "")
    }

    func testSetOffImageOnAScreenThatIsGoneFailsAsNotFound() async {
        let t = FakeTransport()
        t.on("/api/scenes/s1") { _ in (200, ["scene": ["presets": [["elements": []]]]]) }
        do {
            try await StreamModel(api: makeApi(t), sceneId: "s1").setOffImage("v9", "https://x/p.png")
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? ApiError, .status(404, code: "not_found"))
        }
        XCTAssertEqual(t.count("/api/elements/v9"), 0)
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
