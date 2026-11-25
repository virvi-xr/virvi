import Foundation

/// Proves a write comes from this install (App Attest on the phone). `assertion(for:)` is given the exact bytes that
/// go on the wire and returns the `X-Virvi-Attest` header value, `<keyId>.<base64 assertion>`; registering the key
/// with the server is the attester's own business. It is asked again for each attempt, since an assertion is used once.
public protocol Attester: Sendable {
    func assertion(for body: Data) async throws -> String
    /// The server refused the install's key (`bad_assertion`: invalidated, or the app was reinstalled): drop it, so the
    /// next `assertion(for:)` makes and registers a new one. The request is tried once more after this.
    func renewKey() async
}

public extension Attester {
    func renewKey() async {}
}

/// An attester's way to say this phone can't attest at all (the simulator, old devices): the write is refused with
/// `VisitorCopy.BEAT_PHONE_CANT` and not tried again.
public struct AttestUnsupported: Error, Sendable {
    public init() {}
}

/// The phone's position, as the server wants it. Sent only at check-in and claim; the server doesn't keep it.
public struct BeatLocation: Equatable, Sendable {
    public var lat: Double
    public var lng: Double
    public var accuracyM: Double

    public init(lat: Double, lng: Double, accuracyM: Double) {
        self.lat = lat
        self.lng = lng
        self.accuracyM = accuracyM
    }

    var wire: Props { ["lat": lat, "lng": lng, "accuracyM": accuracyM] }
}

/// Where tracking starts from: an AR space the visitor is in, or an event's ARC they scanned (with where they are).
public enum BeatVia: Equatable, Sendable {
    case space(String)
    case arc(code: String, location: BeatLocation?)
}

/// What an ARC is in the app: a space's marker, or an event BEAT's ARC (`card` is the caller's own, when signed in).
public enum AppArc: Equatable, Sendable {
    case space(MarkerLookup)
    case beat(beatId: String, name: String, card: AppBeatCard?)
}

public enum AppBeatResult<T> {
    case ok(T)
    case error(AppBeatError)
}

extension AppBeatResult: Sendable where T: Sendable {}
extension AppBeatResult: Equatable where T: Equatable {}

/// The app's BEAT routes (`/api/app/...`, apps/server/src/beats/app-routes.ts). Every call needs the signed-in session;
/// writes also carry the install's proof over the exact body sent.
public final class AppBeatApi: Sendable {
    private let base: String
    private let transport: HttpTransport
    private let session: AppSession
    private let attest: Attester
    private let appVersion: String?

    public init(baseUrl: URL, transport: HttpTransport, session: AppSession, attest: Attester, appVersion: String? = nil) {
        var b = baseUrl.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.transport = transport
        self.session = session
        self.attest = attest
        self.appVersion = appVersion
    }

    /// `GET /api/app/spaces/:spaceId/beat`: the BEAT running in a space, if any.
    public func spaceBeat(_ spaceId: String) async -> AppBeatResult<AppBeatCard?> {
        await run(.get, "/api/app/spaces/\(enc(spaceId))/beat", body: nil) { (o: [String: Any]) -> AppBeatCard?? in
            if o["beat"] == nil || o["beat"] is NSNull { return .some(nil) }
            return parseAppBeatCard(o["beat"]).map { .some($0) }
        }
    }

    /// `GET /api/app/arcs/:code`. Signed out it is asked without a token: the server answers a space's ARC as ever and an
    /// event's with no card (the BEAT's name only), so the app can ask the visitor to sign in.
    public func arc(_ code: String) async -> AppBeatResult<AppArc> {
        await run(.get, "/api/app/arcs/\(enc(code))", body: nil, anonymousOk: true) { o in
            switch o["kind"] as? String {
            case "space":
                guard let lookup = o["lookup"], let data = try? JSONSerialization.data(withJSONObject: lookup),
                      let m = parseLookup(data) else { return nil }
                return .space(m)
            case "beat":
                guard let id = o["beatId"] as? String, let name = o["name"] as? String else { return nil }
                return .beat(beatId: id, name: name, card: parseAppBeatCard(o["card"]))
            default: return nil
            }
        }
    }

    /// `POST /api/app/beats/:beatId/track`: consents to the current text and starts tracking.
    public func track(_ beatId: String, via: BeatVia) async -> AppBeatResult<AppBeatCard> {
        var body: Props = ["consentVersion": BEAT_APP_CONSENT_VERSION]
        switch via {
        case .space(let id): body["spaceId"] = id
        case .arc(let code, let location):
            body["arcCode"] = code
            if let location { body["location"] = location.wire }
        }
        return await write(.post, "/api/app/beats/\(enc(beatId))/track", body, Self.card)
    }

    /// `POST /api/app/beats/:beatId/checkin`
    public func checkIn(_ beatId: String, spaceId: String) async -> AppBeatResult<AppBeatCard> {
        await write(.post, "/api/app/beats/\(enc(beatId))/checkin", ["spaceId": spaceId], Self.card)
    }

    /// `POST /api/app/beats/:beatId/claim`: with no wallet the server picks the only one, asks to choose (`choose_wallet`), or saves the claim.
    public func claim(_ beatId: String, wallet: String?, location: BeatLocation?) async -> AppBeatResult<AppBeatCard> {
        var body: Props = [:]
        if let wallet { body["wallet"] = wallet }
        if let location { body["location"] = location.wire }
        return await write(.post, "/api/app/beats/\(enc(beatId))/claim", body, Self.card)
    }

    /// `DELETE /api/app/beats/:beatId/track`: stops tracking and deletes what was stored.
    public func stopTracking(_ beatId: String) async -> AppBeatResult<Void> {
        await run(.delete, "/api/app/beats/\(enc(beatId))/track", body: Data(), signed: true) { _ in () }
    }

    /// `GET /api/app/beats/mine`
    public func mine() async -> AppBeatResult<[AppBeatCard]> {
        await run(.get, "/api/app/beats/mine", body: nil) { o in
            guard let list = o["beats"] as? [Any] else { return nil }
            let cards = list.compactMap(parseAppBeatCard)
            return cards.count == list.count ? cards : nil
        }
    }

    // MARK: transport

    private enum Method: String { case get = "GET", post = "POST", delete = "DELETE" }

    private struct AttestFailed: Error {}

    private static func card(_ o: [String: Any]) -> AppBeatCard? { parseAppBeatCard(o["beat"]) }

    /// A write: the JSON body is encoded once and those bytes are both signed and sent.
    private func write<T>(_ method: Method, _ path: String, _ body: Props, _ parse: @escaping ([String: Any]) -> T?) async -> AppBeatResult<T> {
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            return .error(AppBeatError(status: 0, code: "bad_request", message: VisitorCopy.BEAT_TRY_AGAIN))
        }
        return await run(method, path, body: data, signed: true, parse)
    }

    /// Sends, and when the server refuses the install's key (`bad_assertion`) asks the attester for a new one and sends once more.
    private func run<T>(_ method: Method, _ path: String, body: Data?, signed: Bool = false, anonymousOk: Bool = false,
                        _ parse: @escaping ([String: Any]) -> T?) async -> AppBeatResult<T> {
        let first = await attempt(method, path, body: body, signed: signed, anonymousOk: anonymousOk, parse)
        guard signed, case .error(let e) = first, e.code == "bad_assertion" else { return first }
        await attest.renewKey()
        return await attempt(method, path, body: body, signed: signed, anonymousOk: false, parse)
    }

    private func attempt<T>(_ method: Method, _ path: String, body: Data?, signed: Bool, anonymousOk: Bool,
                            _ parse: @escaping ([String: Any]) -> T?) async -> AppBeatResult<T> {
        guard let url = URL(string: base + path) else {
            return .error(AppBeatError(status: 0, code: "bad_request", message: VisitorCopy.BEAT_TRY_AGAIN))
        }
        do {
            let send: (String?) async throws -> (Data, HTTPURLResponse) = { token in
                var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
                r.httpMethod = method.rawValue
                if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
                if let appVersion = self.appVersion { r.setValue(appVersion, forHTTPHeaderField: "X-Virvi-App-Version") }
                if let body {
                    if !body.isEmpty {
                        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
                        r.httpBody = body
                    }
                    if signed {
                        do { r.setValue(try await self.attest.assertion(for: body), forHTTPHeaderField: "X-Virvi-Attest") }
                        catch is AttestUnsupported { throw AttestUnsupported() }
                        catch { throw AttestFailed() }
                    }
                }
                return try await self.transport.send(r)
            }
            let answer: (Data, HTTPURLResponse)?
            if anonymousOk, !session.signedIn { answer = try await send(nil) }
            else { answer = try await session.authorized { try await send($0) } }
            guard let (data, response) = answer else {
                return .error(AppBeatError(status: 0, code: "signed_out", message: VisitorCopy.BEAT_SIGN_IN))
            }
            let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard (200...299).contains(response.statusCode) else {
                return .error(AppBeatError(status: response.statusCode, code: o?["error"] as? String ?? "http_\(response.statusCode)",
                                           message: o?["message"] as? String ?? VisitorCopy.BEAT_TRY_AGAIN,
                                           wallets: o?["wallets"] as? [String] ?? []))
            }
            // A 204 has no body; its parse takes an empty object
            guard let parsed = parse(o ?? [:]) else {
                return .error(AppBeatError(status: response.statusCode, code: "bad_data", message: VisitorCopy.BEAT_TRY_AGAIN))
            }
            return .ok(parsed)
        } catch is AttestUnsupported {
            return .error(AppBeatError(status: 0, code: "attest_unsupported", message: VisitorCopy.BEAT_PHONE_CANT))
        } catch is AttestFailed {
            return .error(AppBeatError(status: 0, code: "attest_failed", message: "This app couldn't be verified. Update the Virvi app and try again."))
        } catch {
            return .error(AppBeatError(status: 0, code: "offline", message: VisitorCopy.OFFLINE))
        }
    }

    /// Escapes a path value (everything but unreserved characters).
    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")) ?? s
    }
}
