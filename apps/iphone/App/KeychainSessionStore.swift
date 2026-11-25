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

    func save(_ t: AppTokens?) { write(t) }

    /// Stores `t` (nil removes it) and gives the Keychain's status, `errSecSuccess` when it worked. An existing item is
    /// updated in place, so a failed write keeps what was stored.
    @discardableResult
    func write(_ t: AppTokens?) -> OSStatus {
        guard let t else {
            let s = SecItemDelete(query as CFDictionary)
            return s == errSecItemNotFound ? errSecSuccess : s
        }
        guard let data = try? JSONEncoder().encode(t) else { return errSecParam }
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let updated = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        guard updated == errSecItemNotFound else { return updated }
        return SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    }
}
