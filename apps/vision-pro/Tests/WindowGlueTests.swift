import XCTest

/// Core pieces the window (Task 11) binds to: the Stats URL, error wording, the upload link and Alerts wiring.
final class WindowGlueTests: XCTestCase {
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

    /// Expected values are what packages/core/src/dashboard-url.ts `analyticsUrlFor` returns for the same input.
    func testAnalyticsUrlMatchesCore() {
        XCTAssertEqual(analyticsUrlFor(apiUrl: "https://virvi.io", sceneId: "3f2a-scene 1/é!*'()~"),
                       "https://virvi.io/analytics/?scene=3f2a-scene%201%2F%C3%A9!*'()~")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "https://api.virvi.io:443/", sceneId: "s1"), "https://virvi.io/analytics/?scene=s1")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "http://staging-api.virvi.io:8080/x", sceneId: "s1"),
                       "http://staging.virvi.io:8080/analytics/?scene=s1")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "http://127.0.0.1:8787", sceneId: "s1"), "http://localhost:3000/analytics/?scene=s1")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "ftp://x", sceneId: "s1"), "https://virvi.io/analytics/?scene=s1")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "https://user@virvi.io", sceneId: "s1"), "https://virvi.io/analytics/?scene=s1")
        XCTAssertEqual(analyticsUrlFor(apiUrl: "HTTPS://API.Virvi.IO", sceneId: "a&b=c"), "https://virvi.io/analytics/?scene=a%26b%3Dc")
    }

    func testFriendlyRenameError() {
        XCTAssertEqual(friendlyRenameError(ApiError.status(400, code: nil)), "Names need 1-120 characters, without slashes")
        XCTAssertEqual(friendlyRenameError(ApiError.status(409, code: "not_ready")), "That file isn't ready yet")
        XCTAssertEqual(friendlyRenameError(ApiError.status(403, code: nil)), "You don't have permission to edit this scene")
        XCTAssertEqual(friendlyRenameError(ApiError.status(500, code: nil)), "Something went wrong — try again")
    }

    func testFriendlyRoleError() {
        XCTAssertEqual(friendlyRoleError(ApiError.status(403, code: "Forbidden")), "Only the host and co-hosts can manage roles.")
        XCTAssertEqual(friendlyRoleError(ApiError.status(409, code: "is_host")), "That wallet is the host.")
        XCTAssertEqual(friendlyRoleError(ApiError.status(400, code: "whatever")), "Something went wrong — try again")
        XCTAssertEqual(friendlyRoleError(ApiError.offline), "Can't reach virvi.io: check the connection and try again")
    }

    func testUploadLinkAsksForImagesAndModels() async throws {
        let t = FakeTransport()
        t.on("/api/upload-tokens") { _ in (201, ["token": [
            "code": "K7Q2", "uploadUrl": "https://virvi.io/u/K7Q2", "qrUrl": "https://virvi.io/qr/K7Q2.png",
            "expiresAt": "2026-11-01T14:05:00.000Z", "maxUploads": 10,
        ]]) }
        let link = try await AssetsModel(api: makeApi(t), sceneId: "s1").uploadLink()
        XCTAssertEqual(link.code, "K7Q2")
        XCTAssertEqual(link.uploadUrl, "https://virvi.io/u/K7Q2")
        let body = t.bodies("/api/upload-tokens").first
        XCTAssertEqual(body?["sceneId"] as? String, "s1")
        XCTAssertEqual(body?["kinds"] as? [String], ["image", "model"])
        XCTAssertEqual(body?["maxUploads"] as? Int, 10)
        XCTAssertEqual(body?["expiresInMinutes"] as? Int, 30)
        XCTAssertEqual(AssetsModel.expiryLine(link, timeZone: TimeZone(identifier: "UTC")!), "Link expires 14:05 · 10 uploads")
        XCTAssertEqual(AssetsModel.uploadFailedCopy, "Couldn't make an upload link — try again")
    }

    func testUploadLinkErrorCopy() {
        XCTAssertEqual(AssetsModel.uploadLinkError(ApiError.offline), "Can't reach virvi.io: check the connection and try again")
        XCTAssertEqual(AssetsModel.uploadLinkError(ApiError.status(500, code: nil)), "Couldn't make an upload link — try again")
    }

    @MainActor
    func testHeldLineBecomesOneAlertBesideOtherMessages() {
        let alerts = HudAlerts(log: AlertsLog())
        alerts.heldLine(nil)
        alerts.heldLine("being moved by Ana")
        alerts.editMessage("Save or revert changes to Crate first.")
        alerts.editMessage(nil)
        alerts.heldLine("being moved by Ana") // republished while still held: one alert
        XCTAssertEqual(alerts.entries.map(\.text), ["Save or revert changes to Crate first.", "being moved by Ana"])
        alerts.heldLine(nil)
        alerts.heldLine("being moved by Ana") // held again later: a new alert
        XCTAssertEqual(alerts.entries.count, 3)
    }

    @MainActor
    func testEditFailuresAndFeedDiffsBecomeAlerts() {
        let alerts = HudAlerts(log: AlertsLog())
        alerts.editMessage(nil)
        XCTAssertTrue(alerts.entries.isEmpty)
        alerts.editMessage("being moved by Ana")
        alerts.editMessage("being moved by Ana") // the same message republished is one alert
        alerts.editMessage(nil)
        alerts.editMessage("Can't reach virvi.io: check the connection and try again")
        XCTAssertEqual(alerts.entries.map(\.text), ["Can't reach virvi.io: check the connection and try again", "being moved by Ana"])
        XCTAssertEqual(alerts.entries.map(\.kind), [.error, .error])
        XCTAssertEqual(alerts.toast?.text, "Can't reach virvi.io: check the connection and try again")

        alerts.scene(scene(#"{"videos":[{"sk":"v1","isLive":false}]}"#)) // the first scene has nothing to compare with
        XCTAssertEqual(alerts.entries.count, 2)
        alerts.scene(scene(#"{"videos":[{"sk":"v1","isLive":true}]}"#))
        XCTAssertEqual(alerts.entries.first?.text, "Stream is live")
        XCTAssertEqual(alerts.entries.first?.kind, .info)
        alerts.scene(scene(#"{"videos":[{"sk":"v1","isLive":false}]}"#))
        XCTAssertEqual(alerts.entries.first?.text, "Stream went offline")
        XCTAssertEqual(alerts.entries.count, 4)

        alerts.dismissToast()
        XCTAssertNil(alerts.toast)
    }
}
