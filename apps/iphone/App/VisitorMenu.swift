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

/// The camera view's settings: look at the ARC again, hide behind people and things (LiDAR phones only), report this
/// space, close. The account and BEATs live on the BEATs tab.
struct VisitorMenu: View {
    let controller: VisitorController
    /// Whether the phone has scene depth (LiDAR); the occlusion switch shows only then.
    let occlusionSupported: Bool
    @Binding var occlusionOn: Bool
    let close: () -> Void

    @State private var reporting = false

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
            if let note = controller.menuNote {
                Text(note).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            wide(VisitorCopy.CLOSE, action: close)
        }
        .padding(16)
        .onDisappear { controller.menuNote = nil }
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
