import SwiftUI

/// The pairing code in large type, a QR of the approval page, and Cancel (the Quest's PairingPanel).
struct PairingView: View {
    let code: String
    let approveUrl: URL
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Text(formatPairingCode(code))
                .font(.system(size: 64, weight: .bold, design: .monospaced))
                .foregroundStyle(Hud.text)
            QRCodeView(text: approveUrl.absoluteString, size: 240)
            Text("Approve on virvi.io on your phone or computer")
                .font(.system(size: 19)).foregroundStyle(Hud.text.opacity(0.88))
            HudButton(label: "Cancel", width: 160, action: onCancel)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Hud.bg)
    }
}
