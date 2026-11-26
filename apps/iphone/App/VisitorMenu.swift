import SwiftUI
import VirviARKit

/// The small "⋯" button that opens the menu.
struct MenuButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "ellipsis")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(HintCard.cardColor, in: Circle())
        }
        .accessibilityLabel("Menu")
    }
}

/// The only settings a visitor sees: look at the ARC again, hide behind people and things (LiDAR phones only), report
/// this space, the account (sign in, or with a code; signed in: My BEATs, sign a headset in, sign out), close.
struct VisitorMenu: View {
    let controller: VisitorController
    let signIn: SignInModel
    let myBeats: MyBeatsModel
    /// Whether the phone has scene depth (LiDAR); the occlusion switch shows only then.
    let occlusionSupported: Bool
    @Binding var occlusionOn: Bool
    let close: () -> Void

    @State private var reporting = false
    @State private var signingHeadsetIn = false
    @State private var showingMyBeats = false
    @State private var signingInWithCode = false

    /// The spec's words for the iPhone's one occlusion mode (ARKit scene depth, people occlusion and the scanned mesh).
    static let HIDE_BEHIND = "Hide behind people and things"
    static let SIGN_IN = "Sign in"
    static let SIGN_OUT = "Sign out"
    static let SIGN_HEADSET_IN = "Sign a headset in"

    var body: some View {
        VStack(spacing: 10) {
            if controller.lookAgainShown {
                wide(VisitorCopy.LOOK_AGAIN, prominent: true) {
                    controller.lookAgain()
                    close()
                }
            }
            if occlusionSupported {
                Toggle(Self.HIDE_BEHIND, isOn: $occlusionOn)
                    .padding(.horizontal, 4)
            }
            if controller.reportSpaceId != nil {
                wide(VisitorCopy.REPORT_SPACE) { reporting = true }
                    .reportSheet(isPresented: $reporting) { controller.report($0) }
            }
            if signIn.signedIn {
                if let name = signIn.userName {
                    Text(name).font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                }
                wide(MyBeatsModel.TITLE) { showingMyBeats = true }
                wide(Self.SIGN_HEADSET_IN) { signingHeadsetIn = true }
                wide(Self.SIGN_OUT) { signIn.signOut() }
            } else {
                wide(Self.SIGN_IN) { signIn.signIn() }
                wide(CodeSignInModel.TITLE) { signingInWithCode = true }
            }
            if let message = signIn.message {
                Text(message).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            if let note = controller.menuNote {
                Text(note).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            wide(VisitorCopy.CLOSE, action: close)
        }
        .padding(16)
        .onDisappear { controller.menuNote = nil }
        .sheet(isPresented: $showingMyBeats) {
            MyBeatsView(model: myBeats, close: { showingMyBeats = false }, opened: {
                showingMyBeats = false
                close()
            })
        }
        .sheet(isPresented: $signingInWithCode) {
            CodeSignInView(model: CodeSignInModel(session: signIn.session)) { signingInWithCode = false }
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $signingHeadsetIn) {
            HeadsetSignInView(model: HeadsetSignInModel(session: signIn.session)) { signingHeadsetIn = false }
                .presentationDetents([.medium])
        }
    }

    private func wide(_ label: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Group {
            if prominent {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            } else {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
    }
}
