import Foundation
import Security

protocol SecretStore: Sendable {
    func load(_ key: String) -> String?
    func save(_ key: String, _ value: String)
    func delete(_ key: String)
}

/// Keychain-backed store (generic passwords under the app's service). Values are never logged.
struct KeychainStore: SecretStore {
    static let service = "io.virvi.builder"

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: key]
    }

    func load(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func save(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query(key)
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(q as CFDictionary, nil)
        }
    }

    func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}

/// In-memory store for tests.
final class MemoryStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func load(_ key: String) -> String? { lock.lock(); defer { lock.unlock() }; return values[key] }
    func save(_ key: String, _ value: String) { lock.lock(); defer { lock.unlock() }; values[key] = value }
    func delete(_ key: String) { lock.lock(); defer { lock.unlock() }; values[key] = nil }
}

enum SecretKey {
    static let headsetSecret = "headsetSecret"
    static let deviceId = "deviceId"
}
