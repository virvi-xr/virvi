import CryptoKit
import DeviceCheck
import Foundation
import Security
import VirviARKit

/// The phone's App Attest service (`DCAppAttestService`; a fake in tests).
protocol AttestService: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}

struct DeviceAttestService: AttestService {
    var isSupported: Bool { DCAppAttestService.shared.isSupported }
    func generateKey() async throws -> String { try await DCAppAttestService.shared.generateKey() }
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash)
    }
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash)
    }
}

/// Where the registered key's id lives (the Keychain on the phone).
protocol AttestKeyStore: Sendable {
    func load() -> String?
    func save(_ keyId: String?)
}

/// The key id in the Keychain, as `KeychainSessionStore` keeps the tokens: a generic password, this device only.
struct KeychainAttestKeyStore: AttestKeyStore {
    let service: String
    private let account = "attest-key"

    init(service: String = "io.virvi.app.attest") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func load() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ keyId: String?) {
        guard let keyId else { SecItemDelete(query as CFDictionary); return }
        let attributes: [String: Any] = [kSecValueData as String: Data(keyId.utf8),
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }
}

/// Proves BEAT writes come from this install (`Attester`). The key is made and registered with the server once, and its
/// id kept; each write is asserted over SHA-256 of the exact body (verify.ts in apps/server/src/app-attest). A key is
/// only kept once the server has accepted it, so a registration that fails leaves nothing behind and the next write
/// makes and registers a new key (App Attest attests a key once). `renewKey()` drops the kept key, for a server that no
/// longer knows it (reinstalled app, invalidated key).
actor AppAttester: Attester {
    private let service: AttestService
    private let store: AttestKeyStore
    private let session: AppSession
    private let transport: HttpTransport
    private let base: String
    private var keyId: String?
    private var registering: Task<String, Error>?

    init(service: AttestService = DeviceAttestService(), store: AttestKeyStore = KeychainAttestKeyStore(),
         baseUrl: URL, transport: HttpTransport, session: AppSession) {
        var b = baseUrl.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.service = service
        self.store = store
        self.transport = transport
        self.session = session
        keyId = store.load()
    }

    func assertion(for body: Data) async throws -> String {
        guard service.isSupported else { throw AttestUnsupported() }
        let id = try await registeredKey()
        let assertion = try await service.generateAssertion(id, clientDataHash: Data(SHA256.hash(data: body)))
        return "\(id).\(assertion.base64EncodedString())"
    }

    func renewKey() async {
        keyId = nil
        store.save(nil)
    }

    private func registeredKey() async throws -> String {
        if let keyId { return keyId }
        if let registering { return try await registering.value }
        let task = Task { try await register() }
        registering = task
        defer { registering = nil }
        let id = try await task.value
        keyId = id
        return id
    }

    private struct RegisterFailed: Error {}

    private func register() async throws -> String {
        let challenge = try await fetchChallenge()
        let id = try await service.generateKey()
        // The server hashes the challenge's text (its UTF-8 bytes), not the bytes the text stands for
        let attestation = try await service.attestKey(id, clientDataHash: Data(SHA256.hash(data: Data(challenge.utf8))))
        let body = try JSONSerialization.data(withJSONObject: ["keyId": id, "attestation": attestation.base64EncodedString(),
                                                              "challenge": challenge], options: [.sortedKeys])
        let (_, response) = try await send("/api/app/attest/register", method: "POST", body: body)
        guard (200...299).contains(response.statusCode) else { throw RegisterFailed() }
        store.save(id)
        return id
    }

    private func fetchChallenge() async throws -> String {
        let (data, response) = try await send("/api/app/attest/challenge", method: "GET", body: nil)
        guard response.statusCode == 200, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let challenge = o["challenge"] as? String, !challenge.isEmpty else { throw RegisterFailed() }
        return challenge
    }

    private func send(_ path: String, method: String, body: Data?) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: base + path) else { throw RegisterFailed() }
        let answer = try await session.authorized { token in
            var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            r.httpMethod = method
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let body {
                r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                r.httpBody = body
            }
            return try await self.transport.send(r)
        }
        guard let answer else { throw RegisterFailed() }
        return answer
    }
}
