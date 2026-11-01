import SwiftUI

/// The pairing code in large type, the approval page's address to type in (a QR inside the headset can't be scanned
/// by the wearer, so it is for someone beside them), and Cancel (the Quest's PairingPanel).
struct PairingView: View {
    let code: String
    let approveUrl: URL
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Text(formatPairingCode(code))
                .font(.system(size: 64, weight: .bold, design: .monospaced))
                .foregroundStyle(Hud.text)
            Text("On your phone or computer, open")
                .font(.system(size: 19)).foregroundStyle(Hud.text.opacity(0.88))
            Text(pairingAddress(approveUrl))
                .font(.system(size: 26, weight: .semibold, design: .monospaced)).foregroundStyle(Hud.virvi)
                .textSelection(.enabled)
            Text("and press Approve. This screen moves on by itself.")
                .font(.system(size: 17)).foregroundStyle(Hud.textDim)
            QRCodeView(text: approveUrl.absoluteString, size: 160)
            HudButton(label: "Cancel", width: 160, action: onCancel)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Hud.bg)
    }
}
