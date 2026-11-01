import Foundation

enum ApiError: Error, Equatable {
    case offline
    case status(Int, code: String?)
    case decode
}

/// The body of a 204 (or any empty 2xx).
struct EmptyResponse: Decodable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// One of the scenes the headset's approver can build on (mirror of ArDeviceScene).
struct DeviceScene: Decodable, Equatable, Identifiable {
    let sceneId: String
    let sceneName: String
    var id: String { sceneId }
}

final class VirviApi: Sendable {
    private let baseUrl: URL
    private let transport: HttpTransport
    private let passes: PassProvider?

    init(baseUrl: URL, transport: HttpTransport, passes: PassProvider?) {
        self.baseUrl = baseUrl
        self.transport = transport
        self.passes = passes
    }

    /// A call that carries no pass (pairing and device routes, authorized by the headset secret in the body).
    func device<T: Decodable>(_ method: String, _ path: String, body: [String: Any]) async throws -> T {
        try Self.decode(try await perform(method, path, body: body, pass: nil, timeout: nil))
    }

    /// A call for a scene, with `Authorization: Bearer <pass>`. A 401 other than `device_revoked` gets one retry
    /// with a freshly minted pass.
    func scene<T: Decodable>(_ sceneId: String, _ method: String, _ path: String, body: [String: Any]?) async throws -> T {
        try Self.decode(try await sceneData(sceneId, method, path, body: body))
    }

    /// Same as `scene`, but hands back the raw body (for callers that parse it themselves). `timeout` overrides the
    /// request timeout, for long polls.
    func sceneData(_ sceneId: String, _ method: String, _ path: String, body: [String: Any]? = nil,
                   timeout: TimeInterval? = nil) async throws -> Data {
        guard let passes else { throw ApiError.status(401, code: "device_revoked") }
        let pass = try await passes.pass(for: sceneId)
        do {
            do {
                return try await perform(method, path, body: body, pass: pass, timeout: timeout)
            } catch ApiError.status(401, let code) where !Self.isRevoked(code) {
                let fresh = try await passes.pass(for: sceneId, forceFresh: true)
                return try await perform(method, path, body: body, pass: fresh, timeout: timeout)
            }
        } catch ApiError.status(401, let code) where Self.isRevoked(code) {
            // The server saw the device revoked on a scene call: forget the passes and go back to pairing.
            await passes.revoked()
            throw ApiError.status(401, code: "device_revoked")
        }
    }

    private static func isRevoked(_ code: String?) -> Bool { code == "device_revoked" || code == "bad_secret" }

    private func perform(_ method: String, _ path: String, body: [String: Any]?, pass: String?, timeout: TimeInterval?) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseUrl)?.absoluteURL else { throw ApiError.decode }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let pass { request.setValue("Bearer \(pass)", forHTTPHeaderField: "Authorization") }

        let data: Data, http: HTTPURLResponse
        do {
            (data, http) = try await transport.send(request)
        } catch is URLError {
            throw ApiError.offline
        }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ApiError.status(http.statusCode, code: code)
        }
        return data
    }

    private static func decode<T: Decodable>(_ data: Data) throws -> T {
        if T.self == EmptyResponse.self { return EmptyResponse() as! T }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ApiError.decode
        }
    }
}
