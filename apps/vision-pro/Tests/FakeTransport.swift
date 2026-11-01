import Foundation

/// A scripted transport: each request is answered by the first handler whose path suffix matches,
/// and every request is recorded.
final class FakeTransport: HttpTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, [String: Any]?)

    private let lock = NSLock()
    private var routes: [(suffix: String, handler: Handler)] = []
    private var log: [URLRequest] = []

    func on(_ suffix: String, _ handler: @escaping Handler) {
        lock.lock(); defer { lock.unlock() }
        routes.append((suffix, handler))
    }

    /// Answers the suffix with each response in turn; the last repeats.
    func script(_ suffix: String, _ responses: [(Int, [String: Any]?)]) {
        let counter = Counter()
        on(suffix) { _ in responses[min(counter.next(), responses.count - 1)] }
    }

    var requests: [URLRequest] { lock.lock(); defer { lock.unlock() }; return log }
    func count(_ suffix: String) -> Int { requests.filter { $0.url!.path.hasSuffix(suffix) }.count }
    func bodies(_ suffix: String) -> [[String: Any]] {
        requests.filter { $0.url!.path.hasSuffix(suffix) }.compactMap {
            $0.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let handler: Handler? = {
            lock.lock(); defer { lock.unlock() }
            log.append(request)
            return routes.first { request.url!.path.hasSuffix($0.suffix) }?.handler
        }()
        guard let handler else { return try respond(request, 404, ["error": "not_found"]) }
        let (status, body) = try handler(request)
        return try respond(request, status, body)
    }

    private func respond(_ request: URLRequest, _ status: Int, _ body: [String: Any]?) throws -> (Data, HTTPURLResponse) {
        let data = body.map { (try? JSONSerialization.data(withJSONObject: $0)) ?? Data() } ?? Data()
        return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = -1
    func next() -> Int { lock.lock(); defer { lock.unlock() }; n += 1; return n }
}

func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
