import SwiftUI

/// Pairing, then the scene picker, then the HUD, following `DeviceAuth.state`.
struct RootView: View {
    @ObservedObject var app: AppModel
    @ObservedObject var auth: DeviceAuth
    @State private var startedOnce = false
    @State private var pairingEnded = false

    var body: some View {
        Group {
            switch auth.state {
            case .unpaired, .refused:
                unpaired
            case .pairing(let code, let url):
                PairingView(code: code, approveUrl: url) { auth.cancel() }
                    .task(id: code) {
                        await auth.pollClaim()
                        if case .unpaired = auth.state { pairingEnded = true }
                    }
            case .paired:
                if let builder = app.builder {
                    HudView(app: app, builder: builder, feed: builder.feed, alerts: builder.alerts)
                } else {
                    ScenePickerView(auth: auth, onPick: { app.open($0) }, autoPick: DebugLaunch.screen == "picker" ? nil : debugPick)
                }
            }
        }
        .onChange(of: auth.state) { _, state in
            if case .paired = state { pairingEnded = false; return }
            app.closeScene() // revoked, signed out or re-pairing: nothing of the old scene is kept
        }
        .task {
            guard !startedOnce else { return }
            startedOnce = true
            if DebugLaunch.screen == "pairing" { auth.cancel() }
            auth.restore()
            if case .unpaired = auth.state { await auth.startPairing() }
        }
    }

    private var unpaired: some View {
        VStack(spacing: 16) {
            Text("Virvi Builder").font(.system(size: 34, weight: .semibold)).foregroundStyle(Hud.text)
            if auth.state == .refused {
                Text("Pairing was refused on virvi.io").font(.system(size: 17)).foregroundStyle(Hud.danger)
            } else if pairingEnded {
                Text("Pairing didn't finish: press Pair this headset to try again").font(.system(size: 17)).foregroundStyle(Hud.textDim)
            }
            HudButton(label: "Pair this headset", color: Hud.accent, width: 260) {
                Task {
                    await auth.startPairing()
                    if case .unpaired = auth.state { pairingEnded = true }
                }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Hud.bg)
    }

    /// DEBUG `-tab` / `-scene`: open a scene straight away for screenshots.
    private func debugPick(_ scenes: [DeviceScene]) -> DeviceScene? {
        if let id = DebugLaunch.sceneId { return scenes.first { $0.sceneId == id } }
        return DebugLaunch.tab != nil ? scenes.first : nil
    }
}
