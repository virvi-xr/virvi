import CryptoKit
import Foundation
import Observation
import SwiftUI
import VirviARKit

/// Signing the phone in with a code approved on a computer, for an account that signs in with a wallet (no wallet on
/// the phone to sign with). The phone starts a `purpose: 'visitor'` pairing (`POST /api/ar/pair`), shows the code, and
/// polls the claim until the code is approved at virvi.io/pair, refused, or runs out; the approved claim carries the
/// account's session, which the phone keeps as if it had signed in on the website. As the Quest's VisitorSignIn.kt. The
/// pairing's device id isn't used here: the phone proves its install with App Attest.
@MainActor
@Observable
final class CodeSignInModel {
    static let TITLE = "Sign in with a code"
    static let INSTRUCTION = "Go to virvi.io/pair on a computer and enter this code:"
    static let EXPIRED = "That code has run out. Get a new code to try again."
    static let REFUSED = "That sign-in was refused."
    static let FAILED = "Couldn't reach Virvi. Try again."
    static let SIGNED_IN = "You're signed in."
    static let NEW_CODE = "Get a code"
    static let pollS: Double = 2

    enum Phase: Equatable {
        case signedOut(note: String?)
        case starting
        /// The code is a credential: shown on screen, never logged.
        case showing(code: String)
        case signedIn
    }

    private(set) var phase: Phase = .signedOut(note: nil)

    @ObservationIgnored private let session: AppSession
    @ObservationIgnored private let transport: HttpTransport
    @ObservationIgnored private let base: String
    @ObservationIgnored private let wallClock: () -> Int64
    @ObservationIgnored private let sleep: @Sendable (Double) async -> Void
    @ObservationIgnored private var running: Task<Void, Never>?

    init(session: AppSession, baseUrl: URL = AppConfig.baseUrl, transport: HttpTransport = URLSessionTransport(),
         wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.session = session
        self.transport = transport
        var b = baseUrl.absoluteString
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.wallClock = wallClock
        self.sleep = sleep
    }

    /// Gets a code and waits for its approval. A second call while one is waiting is ignored.
    func start() {
        guard running == nil else { return }
        phase = .starting
        running = Task { [weak self] in
            await self?.pair()
            self?.running = nil
        }
    }

    /// The visitor closes the code: it is no longer waited for.
    func cancel() {
        running?.cancel()
        running = nil
        if case .signedIn = phase { return }
        phase = .signedOut(note: nil)
    }

    private func pair() async {
        let secret = Self.newSecret()
        let hash = SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
        guard let (status, o) = await post("/api/ar/pair", ["secretHash": hash, "deviceName": "iPhone", "purpose": "visitor"]),
              status == 200, let code = o["code"] as? String, let expires = (o["codeExpiresAt"] as? String).flatMap(Self.ms) else {
            phase = .signedOut(note: Self.FAILED)
            return
        }
        phase = .showing(code: code)
        while wallClock() < expires {
            await sleep(Self.pollS)
            if Task.isCancelled { return }
            guard let (status, o) = await post("/api/ar/pair/\(code)/claim", ["secret": secret]) else { continue } // offline: keep trying
            if Task.isCancelled { return }
            switch status {
            case 200:
                switch o["status"] as? String {
                case "pending": continue
                case "refused": return phase = .signedOut(note: Self.REFUSED)
                default:
                    guard let s = o["session"] as? [String: Any], let access = s["accessToken"] as? String, !access.isEmpty,
                          let refresh = s["refreshToken"] as? String, !refresh.isEmpty else { return phase = .signedOut(note: Self.FAILED) }
                    let name = (s["user"] as? [String: Any])?["displayName"] as? String
                    session.signIn(AppTokens(accessToken: access, refreshToken: refresh, userName: name))
                    return phase = .signedIn
                }
            case 404: return phase = .signedOut(note: Self.EXPIRED)
            default: continue // rate limited or a server hiccup: keep trying until the code runs out
            }
        }
        phase = .signedOut(note: Self.EXPIRED)
    }

    private func post(_ path: String, _ body: [String: Any]) async -> (Int, [String: Any])? {
        guard let url = URL(string: base + path), let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else { return nil }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = data
        guard let (answer, response) = try? await transport.send(r) else { return nil }
        return (response.statusCode, (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any] ?? [:])
    }

    private static func ms(_ s: String) -> Int64? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
        return d.map { Int64($0.timeIntervalSince1970 * 1000) }
    }

    private static func newSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// The code screen: the code in large letters with where to enter it, then "You're signed in".
struct CodeSignInView: View {
    let model: CodeSignInModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(CodeSignInModel.TITLE).font(.headline)
            switch model.phase {
            case .starting: ProgressView().frame(maxWidth: .infinity)
            case .showing(let code):
                Text(CodeSignInModel.INSTRUCTION).font(.subheadline)
                Text(code).font(.system(size: 34, weight: .bold, design: .monospaced)).frame(maxWidth: .infinity)
                    .textSelection(.enabled)
                ProgressView().frame(maxWidth: .infinity)
            case .signedIn: Text(CodeSignInModel.SIGNED_IN).font(.subheadline)
            case .signedOut(let note):
                if let note { Text(note).font(.subheadline).foregroundStyle(.secondary) }
                Button { model.start() } label: { Text(CodeSignInModel.NEW_CODE).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
            Button {
                model.cancel()
                close()
            } label: { Text(VisitorCopy.CLOSE).frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
        }
        .padding(16)
        .onAppear { if case .signedOut(nil) = model.phase { model.start() } }
    }
}
