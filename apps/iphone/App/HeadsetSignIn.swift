import Observation
import SwiftUI
import VirviARKit

/// What the server says about a headset's code.
struct HeadsetPairing: Equatable {
    let code: String
    let deviceName: String
    let purpose: String
}

/// Signing a Quest headset in to this account: look the code up, show who is asking, and approve only on a deliberate tap.
@MainActor
@Observable
final class HeadsetSignInModel {
    static let HEADLINE = "Sign this headset in to your Virvi account"
    static let WARNING = "Only approve a headset you're holding. It will be signed in as you."
    static let REPORTED = "Name reported by the device"
    static let BUILDER = "This code is for building spaces. Go to virvi.io/pair on your computer to approve it."
    static let NOT_FOUND = "That code isn't right, or it has run out. Check the headset and try again."
    static let FAILED = "Couldn't reach Virvi. Try again."
    static let APPROVED = "Done. The headset is signed in."
    static let SIGN_IN_FIRST = "Sign in to Virvi first."

    private let session: AppSession
    private let transport: HttpTransport
    private let base: String

    var input = ""
    private(set) var pairing: HeadsetPairing?
    private(set) var note: String?
    private(set) var approved = false
    private(set) var busy = false

    init(session: AppSession, baseUrl: URL = AppConfig.baseUrl, transport: HttpTransport = URLSessionTransport()) {
        self.session = session
        self.transport = transport
        var b = baseUrl.absoluteString
        while b.hasSuffix("/") { b.removeLast() }
        base = b
    }

    /// A typed code as the server reads it: upper case, without dashes or spaces; only letters and digits can be sent.
    static func cleaned(_ s: String) -> String? {
        let c = s.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard !c.isEmpty, c.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) }) else { return nil }
        return c
    }

    func lookUp() async {
        note = nil; approved = false; pairing = nil
        guard let code = Self.cleaned(input) else { note = Self.NOT_FOUND; return }
        busy = true; defer { busy = false }
        switch await call("GET", code: code, path: "", body: nil) {
        case .none: note = Self.SIGN_IN_FIRST
        case .some((let status, let data)):
            guard status == 200, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let name = o["deviceName"] as? String else {
                note = status == 404 ? Self.NOT_FOUND : Self.FAILED
                return
            }
            let purpose = o["purpose"] as? String ?? "builder"
            if purpose == "visitor" {
                pairing = HeadsetPairing(code: code, deviceName: name, purpose: purpose)
            } else {
                // A builder headset is approved on the website, where the kind of headset is chosen.
                note = Self.BUILDER
            }
        }
    }

    /// Only ever called from the confirm button, for a code `lookUp` showed.
    func approve() async {
        guard let p = pairing, !busy else { return }
        busy = true; defer { busy = false }
        let body = try? JSONSerialization.data(withJSONObject: ["kind": "personal"])
        switch await call("POST", code: p.code, path: "/approve", body: body) {
        case .none: note = Self.SIGN_IN_FIRST
        case .some((let status, _)):
            if status == 200 { approved = true; pairing = nil; input = ""; note = Self.APPROVED }
            else if status == 404 { pairing = nil; note = Self.NOT_FOUND }
            else { note = Self.FAILED }
        }
    }

    func cancel() { pairing = nil; note = nil }

    private func call(_ method: String, code: String, path: String, body: Data?) async -> (Int, Data)? {
        guard let url = URL(string: "\(base)/api/ar/pair/\(code)\(path)") else { return (0, Data()) }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = method
        if let body { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let transport = transport
        do {
            guard let (data, response) = try await session.authorized({ token in
                var a = r
                a.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                return try await transport.send(a)
            }) else { return nil }
            return (response.statusCode, data)
        } catch {
            return (0, Data())
        }
    }
}

/// The approval screen: a code field, then who is asking and a deliberate confirm button.
struct HeadsetSignInView: View {
    @State var model: HeadsetSignInModel
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let p = model.pairing {
                Text(HeadsetSignInModel.HEADLINE).font(.headline)
                VStack(alignment: .leading, spacing: 2) {
                    Text(HeadsetSignInModel.REPORTED).font(.caption).foregroundStyle(.secondary)
                    Text(p.deviceName).font(.title3.weight(.semibold))
                }
                Text(HeadsetSignInModel.WARNING).font(.subheadline)
                Button { Task { await model.approve() } } label: {
                    Text("Sign this headset in").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy)
                Button(role: .cancel) { model.cancel() } label: { Text("Cancel").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).controlSize(.large)
            } else {
                Text("Sign a headset in").font(.headline)
                Text("Enter the code the headset shows.").font(.subheadline).foregroundStyle(.secondary)
                TextField("Code", text: $model.input)
                    .textFieldStyle(.roundedBorder).textInputAutocapitalization(.characters).autocorrectionDisabled()
                Button { Task { await model.lookUp() } } label: { Text("Continue").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy || model.input.isEmpty)
                Button(action: close) { Text("Close").frame(maxWidth: .infinity) }.buttonStyle(.bordered).controlSize(.large)
            }
            if let note = model.note { Text(note).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding(16)
    }
}
