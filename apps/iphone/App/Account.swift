import Foundation
import Observation
import SwiftUI
import VirviARKit

/// The Privacy Policy, Terms of Service and support, on the Virvi website.
enum LegalLinks {
    static let PRIVACY = "Privacy Policy"
    static let TERMS = "Terms of Service"
    static let SUPPORT = "Help and support"

    static var privacy: URL { AppConfig.baseUrl.appendingPathComponent("privacy") }
    static var terms: URL { AppConfig.baseUrl.appendingPathComponent("terms") }
    static let support = URL(string: "mailto:support@virvi.io")!
}

/// The three links, small, as a footer.
struct LegalFooter: View {
    var body: some View {
        HStack(spacing: 14) {
            Link(LegalLinks.PRIVACY, destination: LegalLinks.privacy)
            Link(LegalLinks.TERMS, destination: LegalLinks.terms)
            Link("Support", destination: LegalLinks.support)
        }
        .font(.footnote)
        .frame(maxWidth: .infinity)
    }
}

/// Deleting the Virvi account from the app (`DELETE /api/auth/account`): the visitor types DELETE; an account with a
/// password is asked for it too (the server says so). Done: signed out on this phone.
@MainActor
@Observable
final class DeleteAccountModel {
    static let TITLE = "Delete account"
    static let EXPLAIN = "This deletes your Virvi account and everything in it: your spaces, your BEATs in progress and your data. BEATs already sent to a wallet stay in that wallet. This can't be undone."
    static let TYPE_DELETE = "Type DELETE to confirm"
    static let ENTER_PASSWORD = "Enter your password to confirm."
    static let WRONG_PASSWORD = "That password isn't right."
    static let FAILED = "Couldn't delete your account. Try again, or email support@virvi.io."
    static let DELETED = "Your account has been deleted."
    static let BUTTON = "Delete my account"

    enum Phase: Equatable { case confirming, deleting, deleted }

    var typed = ""
    var password = ""
    private(set) var needsPassword = false
    private(set) var note: String?
    private(set) var phase: Phase = .confirming

    @ObservationIgnored private let session: AppSession
    @ObservationIgnored private let url: URL
    @ObservationIgnored private let transport: HttpTransport

    init(session: AppSession, baseUrl: URL = AppConfig.baseUrl, transport: HttpTransport = URLSessionTransport()) {
        self.session = session
        url = baseUrl.appendingPathComponent("api/auth/account")
        self.transport = transport
    }

    var canDelete: Bool {
        phase == .confirming && typed.trimmingCharacters(in: .whitespaces).uppercased() == "DELETE"
            && (!needsPassword || !password.isEmpty)
    }

    func delete() async {
        guard canDelete else { return }
        phase = .deleting
        note = nil
        var body: [String: Any] = ["confirm": "DELETE"]
        if needsPassword { body["password"] = password }
        let data = try? JSONSerialization.data(withJSONObject: body)
        let answer = try? await session.authorized { token in
            var r = URLRequest(url: self.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
            r.httpMethod = "DELETE"
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            r.httpBody = data
            return try await self.transport.send(r)
        }
        guard let (data, response) = answer ?? nil else {
            phase = .confirming
            note = Self.FAILED
            return
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = json?["error"] as? String
        switch response.statusCode {
        case 200, 204:
            session.signOut()
            phase = .deleted
        case 400 where error?.hasPrefix("Password is required") == true:
            needsPassword = true
            phase = .confirming
            note = Self.ENTER_PASSWORD
        case 401 where error == "Incorrect password":
            phase = .confirming
            note = Self.WRONG_PASSWORD
        default:
            phase = .confirming
            note = (json?["message"] as? String) ?? Self.FAILED
        }
    }
}

struct DeleteAccountView: View {
    @State var model: DeleteAccountModel
    let close: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if model.phase == .deleted {
                    Text(DeleteAccountModel.DELETED)
                } else {
                    Section { Text(DeleteAccountModel.EXPLAIN) }
                    Section {
                        TextField(DeleteAccountModel.TYPE_DELETE, text: $model.typed)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        if model.needsPassword {
                            SecureField("Password", text: $model.password).textContentType(.password)
                        }
                    } footer: {
                        if let note = model.note { Text(note) }
                    }
                    Section {
                        Button(role: .destructive) { Task { await model.delete() } } label: {
                            if model.phase == .deleting { ProgressView() } else { Text(DeleteAccountModel.BUTTON) }
                        }
                        .disabled(!model.canDelete)
                    }
                }
            }
            .navigationTitle(DeleteAccountModel.TITLE)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.phase == .deleted ? "Done" : "Cancel", action: close)
                }
            }
        }
    }
}
