import XCTest

final class AssetsModelTests: XCTestCase {
    private let base = URL(string: "https://test.virvi.io")!

    private func makeApi(_ t: FakeTransport) -> VirviApi {
        let store = MemoryStore()
        store.save(SecretKey.deviceId, "dev1"); store.save(SecretKey.headsetSecret, "s")
        t.on("/pass") { _ in (200, ["pass": "p", "passExpiresAt": iso(Date().addingTimeInterval(600)), "sceneId": "s1"]) }
        let passes = PassProvider(baseUrl: base, transport: t, secrets: store, onRevoked: {})
        return VirviApi(baseUrl: base, transport: t, passes: passes)
    }

    private func item(_ id: String, _ kind: String = "model", status: String = "ready", url: String = "https://x/a.glb",
                      contentType: String? = nil, name: String? = nil) -> LibraryItem {
        LibraryItem(id: id, kind: kind, name: name ?? "N\(id)", url: url, contentType: contentType, status: status, error: nil)
    }

    func testAssetRowsActionsByStatus() {
        let lib = [
            item("a"),
            item("b", "media", url: "https://x/b.png", contentType: "image/png"),
            item("c", status: "uploading", url: ""),
            item("d", status: "processing", url: ""),
            item("e", status: "failed", url: ""),
            item("f", url: "https://x/f.glb"),
            item("g", "media", url: "https://x/g.mp4", contentType: "video/mp4"),
        ]
        let rows = AssetsModel.rows(library: lib, missingSrcs: ["https://x/f.glb"]).rows
        XCTAssertEqual(rows.map(\.id), ["a", "b", "c", "d", "e", "f"], "video is not placeable from the HUD")
        XCTAssertEqual(rows.map(\.tag), ["GLB", "IMG", "GLB", "GLB", "GLB", "GLB"])
        XCTAssertEqual(rows.map(\.badge), ["✓ Available", "✓ Available", "• Uploading", "• Processing", "✕ Failed", "⟳ Needs sync"])
        XCTAssertEqual(rows.map(\.action), [.place, .place, .none, .none, .dismiss, .place])
    }

    func testAssetRowsCapAt10() {
        let lib = (0..<13).map { item("i\($0)") }
        let r = AssetsModel.rows(library: lib)
        XCTAssertEqual(r.rows.count, 10)
        XCTAssertEqual(r.more, 3)
        XCTAssertEqual(AssetsModel.moreLine(3), "+3 more — place them from the dashboard")
        XCTAssertEqual(AssetsModel.syncNotice(missing: 2), "2 model(s) need sync + redeploy — run npx @virvixr/dcl sync")
        XCTAssertNil(AssetsModel.syncNotice(missing: 0))
    }

    func testRenameDismissAndUploadUrl() async throws {
        let t = FakeTransport()
        t.on("/library/a") { req in req.httpMethod == "DELETE" ? (204, nil) : (200, ["item": ["id": "a"]]) }
        t.on("/api/upload-tokens") { _ in (201, ["token": ["uploadUrl": "https://virvi.io/u/CODE", "code": "CODE"]]) }
        let m = AssetsModel(api: makeApi(t), sceneId: "s1")
        try await m.rename("a", to: "New")
        try await m.dismiss("a")
        let url = try await m.uploadUrl()
        XCTAssertEqual(url, "https://virvi.io/u/CODE")
        XCTAssertEqual(t.bodies("/library/a").first?["name"] as? String, "New")
        XCTAssertEqual(t.bodies("/api/upload-tokens").first?["sceneId"] as? String, "s1")
        XCTAssertEqual(t.requests.filter { $0.url!.path.hasSuffix("/library/a") }.map(\.httpMethod), ["PATCH", "DELETE"])
    }

    private func placeable(_ t: FakeTransport) {
        t.on("/api/scenes/s1") { _ in (200, ["scene": ["activePresetId": "p1"]]) }
        t.on("/api/presets/p1/elements") { _ in (201, ["element": ["id": "el1"]]) }
    }

    func testPlacePostsElementThenInstance() async throws {
        let t = FakeTransport(); placeable(t)
        t.on("/api/elements/el1/instances") { _ in (201, ["instance": ["id": "in1"]]) }
        let m = AssetsModel(api: makeApi(t), sceneId: "s1")
        let row = try XCTUnwrap(AssetsModel.rows(library: [item("a", name: "Rock")]).rows.first)
        let at = placement(kind: .model, headPosition: [3, 1.6, 4], headYawDeg: 0)
        let placed = try await m.place(row: row, at: at)
        XCTAssertEqual(placed.elementId, "el1")
        XCTAssertEqual(placed.instanceId, "in1")
        let el = try XCTUnwrap(t.bodies("/api/presets/p1/elements").first)
        XCTAssertEqual(el["type"] as? String, "model")
        XCTAssertEqual(el["name"] as? String, "Rock")
        XCTAssertEqual((el["properties"] as? [String: Any])?["modelSrc"] as? String, "https://x/a.glb")
        let inst = try XCTUnwrap(t.bodies("/api/elements/el1/instances").first)
        XCTAssertEqual((inst["position"] as? [String: Double]), ["x": 3, "y": 0, "z": 6])
        XCTAssertEqual((inst["rotation"] as? [String: Double])?["y"], 180)
    }

    func testPlaceDeletesElementWhenInstanceFails() async throws {
        let t = FakeTransport(); placeable(t)
        t.on("/api/elements/el1/instances") { _ in (500, ["error": "boom"]) }
        t.on("/api/elements/el1") { _ in (204, nil) }
        let m = AssetsModel(api: makeApi(t), sceneId: "s1")
        let row = try XCTUnwrap(AssetsModel.rows(library: [item("a")]).rows.first)
        do {
            _ = try await m.place(row: row, at: placement(kind: .model, headPosition: [0, 0, 0], headYawDeg: 0))
            XCTFail("expected failure")
        } catch ApiError.status(500, _) {}
        let deletes = t.requests.filter { $0.httpMethod == "DELETE" && $0.url!.path == "/api/elements/el1" }
        XCTAssertEqual(deletes.count, 1)
    }

    func testPlaceRefusesNotReadyAndNoPreset() async throws {
        let t = FakeTransport()
        t.on("/api/scenes/s1") { _ in (200, ["scene": ["activePresetId": NSNull()]]) }
        let m = AssetsModel(api: makeApi(t), sceneId: "s1")
        let ready = try XCTUnwrap(AssetsModel.rows(library: [item("a")]).rows.first)
        let at = placement(kind: .model, headPosition: [0, 0, 0], headYawDeg: 0)
        do { _ = try await m.place(row: ready, at: at); XCTFail() } catch let e as AssetsError {
            XCTAssertEqual(e.message, "This scene has no active preset — pick one on the dashboard")
        }
        let busy = try XCTUnwrap(AssetsModel.rows(library: [item("c", status: "uploading", url: "")]).rows.first)
        do { _ = try await m.place(row: busy, at: at); XCTFail() } catch let e as AssetsError {
            XCTAssertEqual(e.message, "That file isn't ready yet")
        }
        XCTAssertEqual(t.count("/elements"), 0)
    }
}
