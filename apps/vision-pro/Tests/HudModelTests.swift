import XCTest

final class HudModelTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    func makeApi(_ t: FakeTransport) -> VirviApi {
        let store = MemoryStore()
        store.save(SecretKey.deviceId, "dev1"); store.save(SecretKey.headsetSecret, "s")
        t.on("/pass") { _ in (200, ["pass": "p", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: {})
        return VirviApi(baseUrl: base, transport: t, passes: passes)
    }

    func testTabsOrderAndRolesOnlyForHosts() {
        XCTAssertEqual(HudTab.allCases.map(\.rawValue), ["Layout", "Assets", "Events", "Stream", "Worlds", "Alerts", "Roles", "Stats"])
        XCTAssertEqual(visibleTabs(role: .host), HudTab.allCases)
        XCTAssertEqual(visibleTabs(role: .cohost), HudTab.allCases)
        for role in [SceneRole.editor, .viewer] {
            XCTAssertFalse(visibleTabs(role: role).contains(.roles))
            XCTAssertEqual(visibleTabs(role: role).count, 7)
        }
        XCTAssertTrue(canEdit(.host) && canEdit(.cohost) && canEdit(.editor))
        XCTAssertFalse(canEdit(.viewer))
    }

    func testRoleComesFromDeviceScene() throws {
        func scene(_ role: String?) throws -> DeviceScene {
            var o: [String: Any] = ["sceneId": "s", "sceneName": "n"]
            if let role { o["role"] = role }
            return try JSONDecoder().decode(DeviceScene.self, from: JSONSerialization.data(withJSONObject: o))
        }
        XCTAssertEqual(try scene("host").sceneRole, .host)
        XCTAssertEqual(try scene("cohost").sceneRole, .cohost)
        XCTAssertEqual(try scene("editor").sceneRole, .editor)
        XCTAssertEqual(try scene("wizard").sceneRole, .viewer)
        XCTAssertEqual(try scene(nil).sceneRole, .viewer)
    }

    func testLayoutCapsAt12WithMoreLine() {
        let images = (0..<14).map { ["sk": "e\($0)", "name": "Pic \($0)", "enabled": $0 != 1, "instances": []] as [String: Any] }
        let scene: Props = ["images": images, "models": [["sk": "m", "name": "", "instances": []]]]
        let r = LayoutModel.rows(scene: scene)
        XCTAssertEqual(r.rows.count, 12)
        XCTAssertEqual(r.more, 3)
        XCTAssertEqual(LayoutModel.moreLine(r.more), "+3 more — manage them on the dashboard")
        XCTAssertEqual(r.rows[0], LayoutRow(elementId: "e0", typeTag: "IMA", name: "Pic 0", enabled: true))
        XCTAssertFalse(r.rows[1].enabled)
        XCTAssertEqual(LayoutModel.rows(scene: ["models": [["sk": "m", "name": "", "instances": []]]]).rows[0],
                       LayoutRow(elementId: "m", typeTag: "MOD", name: "Unnamed", enabled: true))
        XCTAssertEqual(LayoutModel.rows(scene: [:]).more, 0)
        XCTAssertEqual(LayoutModel.confirmDeleteCopy, "Delete this element and all its copies? This can't be undone.")
    }

    func testLayoutEditsCallTheServer() async throws {
        let t = FakeTransport()
        t.on("/api/elements/e1") { req in req.httpMethod == "DELETE" ? (204, nil) : (200, ["element": ["id": "e1"]]) }
        let model = LayoutModel(api: makeApi(t), sceneId: "s1")
        try await model.setEnabled("e1", false)
        try await model.delete("e1")
        let sent = t.requests.filter { $0.url!.path == "/api/elements/e1" }
        XCTAssertEqual(sent.map(\.httpMethod), ["PUT", "DELETE"])
        XCTAssertEqual(t.bodies("/api/elements/e1").first?["enabled"] as? Bool, false)
    }

    func testPlacedMessageTexts() {
        func d(_ mode: String, _ status: String, _ granted: Bool) -> PublishDestination {
            PublishDestination(id: "d", world: "w", mode: mode, status: status, granted: granted, pending: 0, publishUrl: "u")
        }
        XCTAssertEqual(placedMessage(name: "Rock", destination: nil).text,
            "Placed Rock — to get it into your World, open this scene's Deploy page in Virvi Studio, or run npx @virvixr/dcl sync and redeploy")
        XCTAssertEqual(placedMessage(name: "Rock", destination: d("virvi", "over_budget", true)).text,
            "Placed Rock — the scene is past Decentraland's limits for this plot, so it can't go live until something is removed")
        XCTAssertEqual(placedMessage(name: "Rock", destination: d("virvi", "needs_review", true)).text,
            "Placed Rock — deploys to your World are paused; check this scene's Deploy page in Virvi Studio")
        let sign = placedMessage(name: "Rock", destination: d("sign", "ready", false))
        XCTAssertEqual(sign.text, "Placed Rock — publish it to see it in your World")
        XCTAssertTrue(sign.publish)
        XCTAssertEqual(placedMessage(name: "Rock", destination: d("virvi", "ready", false)).text,
            "Placed Rock — Virvi needs your permission to deploy it; give it on this scene's Deploy page in Virvi Studio")
        let ok = placedMessage(name: "Rock", destination: d("virvi", "ready", true))
        XCTAssertEqual(ok.text, "Placed Rock — Virvi is adding it to your World; it appears in a minute or two")
        XCTAssertFalse(ok.publish)
    }

    func testPublishDestinationDecodesServerShape() throws {
        let json = #"{"id":"d","world":"w.dcl.eth","mode":"virvi","status":"ready","granted":true,"pending":2,"publishUrl":"https://x/publish/?d=d"}"#
        let d = try JSONDecoder().decode(PublishDestination.self, from: Data(json.utf8))
        XCTAssertEqual(d.pending, 2)
        XCTAssertTrue(d.granted)
    }
}
