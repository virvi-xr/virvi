import Combine
import CryptoKit
import Foundation

enum AuthState: Equatable {
    case unpaired
    case pairing(code: String, approveUrl: URL)
    case paired(deviceId: String)
    case refused
}

func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// The approval page as an address to type in: a QR shown inside the headset can't be scanned.
func pairingAddress(_ url: URL) -> String {
    var host = url.host ?? ""
    if host.hasPrefix("www.") { host.removeFirst(4) }
    if let port = url.port { host += ":\(port)" }
    return host + url.path
}

/// "ABC123" -> "ABC-123" (the Quest's PairingPanel.formatPairingCode).
func formatPairingCode(_ code: String) -> String {
    let c = code.trimmingCharacters(in: .whitespaces).uppercased().replacingOccurrences(of: "-", with: "")
    return c.count == 6 ? "\(c.prefix(3))-\(c.suffix(3))" : code
}

@MainActor
final class DeviceAuth: ObservableObject {
    @Published private(set) var state: AuthState = .unpaired
    /// Why the last "Pair this headset" didn't start: the offline copy when there's no network, otherwise nil.
    @Published private(set) var pairingMessage: String?

    private let api: VirviApi
    private let store: SecretStore
    private let sleep: @Sendable (TimeInterval) async -> Void
    private var pairingCode: String?

    init(baseUrl: URL, transport: HttpTransport, store: SecretStore,
         sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.api = VirviApi(baseUrl: baseUrl, transport: transport, passes: nil)
        self.store = store
        self.sleep = sleep
    }

    /// Picks up a pairing saved in the store (call at launch).
    func restore() {
        if let id = store.load(SecretKey.deviceId), store.load(SecretKey.headsetSecret) != nil {
            state = .paired(deviceId: id)
        }
    }

    private struct Started: Decodable { let code: String; let approveUrl: String }
    private enum Claim: Decodable {
        case pending, refused, approved(String)
        private enum K: String, CodingKey { case status, deviceId }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            switch try c.decode(String.self, forKey: .status) {
            case "approved": self = .approved(try c.decode(String.self, forKey: .deviceId))
            case "refused": self = .refused
            default: self = .pending
            }
        }
    }

    func startPairing() async {
        clearKeys()
        pairingMessage = nil
        var bytes = [UInt8](repeating: 0, count: 32)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        let secret = bytes.map { String(format: "%02x", $0) }.joined()
        store.save(SecretKey.headsetSecret, secret)
        do {
            let s: Started = try await api.device("POST", "/api/ar/pair", body: ["secretHash": sha256Hex(secret), "deviceName": "Apple Vision Pro"])
            guard let url = URL(string: s.approveUrl) else { throw ApiError.decode }
            pairingCode = s.code
            state = .pairing(code: s.code, approveUrl: url)
        } catch {
            clearKeys()
            state = .unpaired
            if case ApiError.offline = error { pairingMessage = friendlyEditMessage(error) }
        }
    }

    func pollClaim() async {
        guard let code = pairingCode, let secret = store.load(SecretKey.headsetSecret) else { return }
        while pairingCode == code, !Task.isCancelled {
            await sleep(2)
            guard pairingCode == code, !Task.isCancelled else { return }
            do {
                let c: Claim = try await api.device("POST", "/api/ar/pair/\(code)/claim", body: ["secret": secret])
                guard pairingCode == code else { return } // cancelled or re-paired while this was in flight
                switch c {
                case .pending: continue
                case .refused:
                    clearKeys(); pairingCode = nil; state = .refused
                    return
                case .approved(let id):
                    store.save(SecretKey.deviceId, id)
                    pairingCode = nil
                    state = .paired(deviceId: id)
                    return
                }
            } catch ApiError.status(let s, _) where s == 401 || s == 404 {
                guard pairingCode == code else { return }
                clearKeys(); pairingCode = nil; state = .unpaired // bad secret or code expired
                return
            } catch {
                continue // offline or a hiccup: keep trying
            }
        }
    }

    func cancel() {
        pairingCode = nil
        pairingMessage = nil
        clearKeys()
        state = .unpaired
    }

    func signOut() async {
        if let id = store.load(SecretKey.deviceId), let secret = store.load(SecretKey.headsetSecret) {
            let _: EmptyResponse? = try? await api.device("POST", "/api/ar/devices/\(id)/end", body: ["secret": secret])
        }
        pairingCode = nil
        clearKeys()
        state = .unpaired
    }

    func scenes() async throws -> [DeviceScene] {
        guard let id = store.load(SecretKey.deviceId), let secret = store.load(SecretKey.headsetSecret) else {
            throw ApiError.status(401, code: "device_revoked")
        }
        do {
            return try await api.device("POST", "/api/ar/devices/\(id)/scenes", body: ["secret": secret])
        } catch ApiError.status(401, let code) where code == "device_revoked" || code == "bad_secret" {
            onRevoked()
            throw ApiError.status(401, code: "device_revoked")
        }
    }

    func onRevoked() {
        pairingCode = nil
        clearKeys()
        state = .unpaired
    }

    private func clearKeys() {
        store.delete(SecretKey.headsetSecret)
        store.delete(SecretKey.deviceId)
    }
}
