import SwiftUI
import VirviARKit

/// A wallet address as the choice shows it: `0x1234…abcd`.
func shortWallet(_ wallet: String) -> String {
    guard wallet.count > 12 else { return wallet }
    return "\(wallet.prefix(6))…\(wallet.suffix(4))"
}

/// The BEAT card at the bottom of the camera view (`BeatModel`): what to do for the BEAT, its button, the wallet choice
/// and what went wrong, in the package's words (`BeatCard`).
struct BeatCardView: View {
    let model: BeatModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let name = model.signInName {
                Text(name).font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                wide(VisitorCopy.BEAT_SIGN_IN, prominent: true) { model.signIn() }
            } else {
                if let current = model.current {
                    Text(current.name).font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
                }
                if let text = model.card.text {
                    Text(text).font(.system(size: 15)).foregroundStyle(HintCard.secondary)
                }
                if case .claiming = model.card.state { ProgressView().tint(.white) }
                if case .chooseWallet(_, let wallets) = model.card.state {
                    ForEach(wallets, id: \.self) { w in wide(shortWallet(w)) { model.claim(wallet: w) } }
                }
                if let title = model.card.buttonTitle, !isWalletChoice {
                    wide(title, prominent: true) { model.primaryAction() }
                }
                if model.canRetry { wide(BeatModel.RETRY) { model.retry() } }
                if model.locationDenied { settingsButton }
                if case .counting = model.card.state { wide(BeatModel.STOP_TRACKING) { model.stopTracking() } }
            }
            if model.origin?.isEvent == true { wide(VisitorCopy.CLOSE) { model.closeEvent() } }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HintCard.cardColor, in: RoundedRectangle(cornerRadius: 16))
        .sheet(isPresented: Binding(get: { model.consentText != nil }, set: { if !$0 { model.declineConsent() } })) {
            consentSheet
        }
    }

    private var isWalletChoice: Bool {
        if case .chooseWallet = model.card.state { return true }
        return false
    }

    private var consentSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            ScrollView { Text(model.consentText ?? "").font(.body) }
            wide(BeatModel.AGREE, prominent: true) { model.acceptConsent() }
            wide(VisitorCopy.REPORT_CANCEL) { model.declineConsent() }
        }
        .padding(20)
        .presentationDetents([.large])
    }

    private var settingsButton: some View {
        Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        .buttonStyle(.borderedProminent)
    }

    private func wide(_ label: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Group {
            if prominent {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            } else {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.bordered).tint(.white)
            }
        }
        .controlSize(.large)
    }
}
