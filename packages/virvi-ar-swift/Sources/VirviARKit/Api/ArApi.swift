import Foundation

public enum ApiResult<T> {
    case ok(T)
    case notFound
    case rateLimited
    /// The server could not be reached (no network, DNS, timeout).
    case offline
    case failed(Int)
}

extension ApiResult: Sendable where T: Sendable {}

extension ApiResult: Equatable where T: Equatable {
    public static func == (a: ApiResult, b: ApiResult) -> Bool {
        switch (a, b) {
        case let (.ok(x), .ok(y)): return x == y
        case (.notFound, .notFound), (.rateLimited, .rateLimited), (.offline, .offline): return true
        case let (.failed(x), .failed(y)): return x == y
        default: return false
        }
    }
}

public enum ReportReason: String, Sendable {
    case offensive, unsafe, spam, other
}

/// How a visitor's report of a space ended.
public enum ReportResult: Equatable, Sendable {
    case sent, rateLimited, failed
}

/// The outcome of a report the server answered with HTTP `status`: 201 is taken, 429 is the per-IP limit, else it failed.
public func reportResultFor(status: Int) -> ReportResult {
    switch status {
    case 201: return .sent
    case 429: return .rateLimited
    default: return .failed
    }
}

/// What became of an analytics batch: taken, worth sending again later, or refused for good.
public enum AnalyticsResult: Equatable, Sendable {
    case sent, retry, drop
}

/// The fate of a batch the server answered with HTTP `status`: a 4xx other than 408 (request timeout) and 429 will never be taken.
public func analyticsResultFor(status: Int) -> AnalyticsResult {
    switch status {
    case 200...299: return .sent
    case 408, 429: return .retry
    case 400...499: return .drop
    default: return .retry
    }
}

/// One analytics event of a visit; `x`, `y`, `z` (scene coordinates) are set on `pos` only.
public struct VisitEvent: Equatable, Sendable {
    public var type: String
    public var playerId: String
    /// UTC ms.
    public var t: Int64
    public var x: Double?
    public var y: Double?
    public var z: Double?

    public init(type: String, playerId: String, t: Int64, x: Double? = nil, y: Double? = nil, z: Double? = nil) {
        self.type = type
        self.playerId = playerId
        self.t = t
        self.x = x
        self.y = y
        self.z = z
    }
}

/// The AR endpoints of a Virvi server (the visitor routes only; anonymous, no token), as the Quest's ArApi.kt.
public final class ArApi: Sendable {
    public static let platform = "ar-ios"

    private let base: String
    private let transport: HttpTransport
    private let appVersion: String

    public init(baseUrl: URL, transport: HttpTransport, appVersion: String) {
        var b = baseUrl.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines)
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.transport = transport
        self.appVersion = appVersion
    }

    /// `GET /api/ar/markers/by-code/:code`
    public func lookup(code: String) async -> ApiResult<MarkerLookup> {
        await get("/api/ar/markers/by-code/\(enc(code))", timeout: 15, parse: parseLookup)
    }

    /// `GET /api/ar/spaces/:id/feed?since=`: the server holds the request up to 25 s until the version changes.
    public func feed(spaceId: String, since: String?) async -> ApiResult<ArFeedSnapshot> {
        await get("/api/ar/spaces/\(enc(spaceId))/feed?since=\(enc(since ?? ""))", timeout: 40, parse: parseFeed)
    }

    /// `POST /api/ar/spaces/:id/report`; offline is `.failed`.
    public func report(spaceId: String, reason: ReportReason) async -> ReportResult {
        let body: Props = ["reason": reason.rawValue, "platform": Self.platform]
        guard let status = await post("/api/ar/spaces/\(enc(spaceId))/report", body: body) else { return .failed }
        return reportResultFor(status: status)
    }

    /// `POST /api/ar/spaces/:id/analytics` (see `analyticsResultFor`); offline is `.retry`.
    public func sendAnalytics(spaceId: String, events: [VisitEvent]) async -> AnalyticsResult {
        let wire: [Props] = events.map { e in
            var o: Props = ["type": e.type, "playerId": e.playerId, "t": e.t]
            if let x = e.x { o["x"] = x }
            if let y = e.y { o["y"] = y }
            if let z = e.z { o["z"] = z }
            return o
        }
        let body: Props = ["v": 1, "platform": Self.platform, "events": wire]
        guard let status = await post("/api/ar/spaces/\(enc(spaceId))/analytics", body: body) else { return .retry }
        return analyticsResultFor(status: status)
    }

    // MARK: transport

    private func request(_ path: String, method: String, timeout: TimeInterval) -> URLRequest? {
        guard let url = URL(string: base + path) else { return nil }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue(appVersion, forHTTPHeaderField: "X-Virvi-App-Version")
        return r
    }

    private func get<T>(_ path: String, timeout: TimeInterval, parse: (Data) -> T?) async -> ApiResult<T> {
        guard let r = request(path, method: "GET", timeout: timeout) else { return .offline }
        do {
            let (data, response) = try await transport.send(r)
            switch response.statusCode {
            case 404: return .notFound
            case 429: return .rateLimited
            case 200...299: return parse(data).map { .ok($0) } ?? .failed(response.statusCode)
            default: return .failed(response.statusCode)
            }
        } catch {
            return .offline
        }
    }

    /// The HTTP status of a JSON POST, or nil when the server could not be reached.
    private func post(_ path: String, body: Props) async -> Int? {
        guard var r = request(path, method: "POST", timeout: 15),
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return nil }
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = data
        return try? await transport.send(r).1.statusCode
    }

    /// Escapes a path or query value like Java's `URLEncoder` (space is `+`), as the Quest does.
    private func enc(_ s: String) -> String {
        var out = ""
        for b in s.utf8 {
            switch b {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "."), UInt8(ascii: "-"), UInt8(ascii: "*"), UInt8(ascii: "_"):
                out.append(Character(UnicodeScalar(b)))
            case UInt8(ascii: " "): out.append("+")
            default: out += String(format: "%%%02X", b)
            }
        }
        return out
    }
}
