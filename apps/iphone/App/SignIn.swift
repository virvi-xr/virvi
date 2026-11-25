import AuthenticationServices
import Observation
import SwiftUI
import VirviARKit

/// The one-time code in the website's `virvi://signed-in?code=<code>` hand-off, or nil for anything else: another
/// scheme or host, no code, or a code that isn't 43 base64url characters (32 random bytes).
func handoffCode(fromCallback url: URL) -> String? {
    guard url.scheme?.lowercased() == "virvi", url.host?.lowercased() == "signed-in",
          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
          let code = items.first(where: { $0.name == "code" })?.value, code.utf8.count == 43,
          code.utf8.allSatisfy({ ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x5F })
    else { return nil }
    return code
}

/// Signs the phone in to a Virvi account through the website in a secure sheet.
@MainActor
@Observable
final class SignInModel: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let FAILED = "Couldn't sign you in. Try again."

    let session: AppSession
    /// Shown in the menu after a failed sign-in; nil otherwise (a cancelled sheet shows nothing).
    private(set) var message: String?
    /// Bumped when the session changes, so views re-read the name.
    private(set) var changes = 0
    private var web: ASWebAuthenticationSession?

    init(session: AppSession) { self.session = session }

    var signedIn: Bool { _ = changes; return session.signedIn }
    var userName: String? { _ = changes; return session.userName }

    func signIn() {
        message = nil
        let url = AppConfig.baseUrl.appendingPathComponent("app-sign-in")
        let web = ASWebAuthenticationSession(url: url, callbackURLScheme: "virvi") { [weak self] callback, error in
            Task { @MainActor in await self?.finish(callback: callback, error: error) }
        }
        web.presentationContextProvider = self
        // Reuse the browser's existing virvi.io sign-in.
        web.prefersEphemeralWebBrowserSession = false
        self.web = web
        if !web.start() { message = Self.FAILED }
    }

    func signOut() {
        session.signOut()
        message = nil
        changes += 1
    }

    private func finish(callback: URL?, error: Error?) async {
        web = nil
        if let e = error as? ASWebAuthenticationSessionError, e.code == .canceledLogin { return }
        guard error == nil, let callback, let code = handoffCode(fromCallback: callback), await session.signIn(exchanging: code) else {
            message = Self.FAILED
            return
        }
        changes += 1
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { ASPresentationAnchor(windowScene: $0) } ?? ASPresentationAnchor()
        }
    }
}
