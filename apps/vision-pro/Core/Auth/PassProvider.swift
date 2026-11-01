import Foundation

/// Mints and caches one scene pass per scene. A pass with under 30 s left is minted again.
actor PassProvider {
    private struct Cached { let pass: String; let expiresAt: Date }

    private let api: VirviApi
    private let secrets: SecretStore
    private let onRevoked: @Sendable () async -> Void
    private let now: @Sendable () -> Date
    private var cache: [String: Cached] = [:]

    init(baseUrl: URL, transport: HttpTransport, secrets: SecretStore,
         onRevoked: @escaping @Sendable () async -> Void,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.api = VirviApi(baseUrl: baseUrl, transport: transport, passes: nil)
        self.secrets = secrets
        self.onRevoked = onRevoked
        self.now = now
    }

    private struct Minted: Decodable { let pass: String; let passExpiresAt: String; let sceneId: String }

    func pass(for sceneId: String, forceFresh: Bool = false) async throws -> String {
        if !forceFresh, let c = cache[sceneId], c.expiresAt.timeIntervalSince(now()) > 30 { return c.pass }
        cache[sceneId] = nil
        guard let deviceId = secrets.load(SecretKey.deviceId), let secret = secrets.load(SecretKey.headsetSecret) else {
            throw ApiError.status(401, code: "device_revoked")
        }
        do {
            let m: Minted = try await api.device("POST", "/api/ar/devices/\(deviceId)/pass", body: ["secret": secret, "sceneId": sceneId])
            guard let expiry = Self.parse(m.passExpiresAt) else { throw ApiError.decode }
            cache[sceneId] = Cached(pass: m.pass, expiresAt: expiry)
            return m.pass
        } catch ApiError.status(401, let code) where code == "device_revoked" || code == "bad_secret" {
            cache = [:]
            await onRevoked()
            throw ApiError.status(401, code: "device_revoked")
        }
    }

    private static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}
