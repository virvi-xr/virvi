import Foundation
import Security
import VirviARKit

/// The signed-in tokens in the Keychain (a generic password, this device only, readable after the first unlock so a
/// background launch still works). It runs under `AppSession`'s lock, so it never calls back into the session, and it
/// never logs a token.
struct KeychainSessionStore: SessionStore {
    let service: String
    private let account = "session"

    init(service: String = "io.virvi.app.session") { self.service = service }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    func load() -> AppTokens? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(AppTokens.self, from: data)
    }

    func save(_ t: AppTokens?) {
        SecItemDelete(query as CFDictionary)
        guard let t, let data = try? JSONEncoder().encode(t) else { return }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}
