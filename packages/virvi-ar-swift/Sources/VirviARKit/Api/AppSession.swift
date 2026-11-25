import Foundation

/// Where the signed-in tokens live (the Keychain on the phone); the package never persists them itself.
public protocol SessionStore: Sendable {
    func load() -> AppTokens?
    func save(_ t: AppTokens?)
}

public struct AppTokens: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String
    public var userName: String?

    public init(accessToken: String, refreshToken: String, userName: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.userName = userName
    }
}

/// The app's account session: signs in with a code from virvi.io (`/api/auth/handoff/exchange`), carries the access
/// token, and refreshes it once when the server refuses it (`/api/auth/refresh`). A refresh the server refuses signs the
/// session out; a refresh that couldn't be tried (no network, a server error) keeps it.
public final class AppSession: @unchecked Sendable {
    private let base: String
    private let transport: HttpTransport
    private let store: SessionStore
    private let lock = NSLock()
    private var tokens: AppTokens?

    public init(baseUrl: URL, transport: HttpTransport, store: SessionStore) {
        var b = baseUrl.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.transport = transport
        self.store = store
        tokens = store.load()
    }

    public var signedIn: Bool { current() != nil }
    public var userName: String? { current()?.userName }

    /// The access token to send, or nil when signed out.
    public func bearer() async -> String? { current()?.accessToken }

    /// Trades an app code (from virvi.io) for a session; false when the code was refused or the server couldn't be reached.
    public func signIn(exchanging code: String) async -> Bool {
        guard let url = URL(string: base + "/api/auth/handoff/exchange"),
              let body = try? JSONSerialization.data(withJSONObject: ["code": code], options: [.sortedKeys]) else { return false }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        guard let (data, response) = try? await transport.send(r), response.statusCode == 200,
              let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let access = o["accessToken"] as? String, !access.isEmpty,
              let refresh = o["refreshToken"] as? String, !refresh.isEmpty else { return false }
        let name = (o["user"] as? [String: Any])?["displayName"] as? String
        set(AppTokens(accessToken: access, refreshToken: refresh, userName: name))
        return true
    }

    public func signOut() { set(nil) }

    /// Sends with the access token. When the server answers 401 it refreshes once and sends again with the new token;
    /// that answer is returned whatever it is (it is never refreshed twice). Nil when signed out, with nothing sent.
    /// `send` is given the token each time, so a request that is signed per attempt signs again.
    public func authorized(_ send: (String) async throws -> (Data, HTTPURLResponse)) async throws -> (Data, HTTPURLResponse)? {
        guard let used = current() else { return nil }
        let first = try await send(used.accessToken)
        guard first.1.statusCode == 401 else { return first }
        // Another request may have refreshed already: use its token rather than refreshing again.
        var next = current()?.accessToken
        if next == used.accessToken { next = await refresh(from: used) }
        guard let next, current() != nil else { return first }
        return try await send(next)
    }

    private func refresh(from used: AppTokens) async -> String? {
        guard let url = URL(string: base + "/api/auth/refresh") else { return nil }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = "POST"
        r.setValue("Bearer \(used.refreshToken)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await transport.send(r) else { return nil }
        switch response.statusCode {
        case 200:
            guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let access = o["accessToken"] as? String, !access.isEmpty else { return nil }
            var t = used
            t.accessToken = access
            if let refresh = o["refreshToken"] as? String, !refresh.isEmpty { t.refreshToken = refresh }
            // A sign-out (or a new sign-in) while this was in flight wins
            let stillSame = isStill(used)
            if stillSame { set(t) }
            return stillSame ? access : nil
        case 400, 401, 403:
            if isStill(used) { set(nil) }
            return nil
        default:
            return nil
        }
    }

    private func isStill(_ used: AppTokens) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return tokens?.refreshToken == used.refreshToken
    }

    private func current() -> AppTokens? {
        lock.lock(); defer { lock.unlock() }
        return tokens
    }

    private func set(_ t: AppTokens?) {
        lock.lock(); tokens = t; lock.unlock()
        store.save(t)
    }
}
