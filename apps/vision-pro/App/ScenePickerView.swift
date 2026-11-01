import SwiftUI

/// "Choose a scene to build", from the scenes the headset's approver can build on.
struct ScenePickerView: View {
    let auth: DeviceAuth
    let onPick: (DeviceScene) -> Void
    var autoPick: ((([DeviceScene]) -> DeviceScene?))?

    @State private var scenes: [DeviceScene]?
    @State private var failed: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Virvi").font(.system(size: 22, weight: .semibold)).foregroundStyle(Hud.text)
                Text("Choose a scene to build").font(.system(size: 15)).foregroundStyle(Hud.textDim)
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Hud.bgLight)

            VStack(alignment: .leading, spacing: 3) {
                if let failed {
                    EmptyPanel(text: failed)
                    HudButton(label: "Retry", color: Hud.accent, width: 140) { Task { await load() } }
                        .frame(maxWidth: .infinity)
                } else if let scenes {
                    if scenes.isEmpty {
                        EmptyPanel(text: "This account has no scenes to build on yet")
                    } else {
                        ForEach(scenes) { s in
                            Button { onPick(s) } label: {
                                CardRow {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(s.sceneName.isEmpty ? "Untitled" : s.sceneName)
                                            .font(.system(size: 17)).foregroundStyle(Hud.text)
                                        Text(RolesModel.roleLabel(s.role).capitalizedFirst)
                                            .font(.system(size: 13)).foregroundStyle(Hud.textMuted)
                                    }
                                    Spacer()
                                    Text("Connect >").font(.system(size: 15)).foregroundStyle(Hud.accent)
                                }
                            }
                            .buttonStyle(.plain)
                            .hoverEffect()
                        }
                    }
                } else {
                    EmptyPanel(text: "Finding your scenes…")
                }
            }
            .padding(14)
            Spacer(minLength: 0)
        }
        .background(Hud.bg)
        .task { await load() }
    }

    private func load() async {
        failed = nil
        do {
            let list = try await auth.scenes()
            scenes = list
            if let pick = autoPick?(list) { onPick(pick) }
        } catch ApiError.status(401, _) {
            // Revoked: DeviceAuth is back to unpaired and the root shows pairing.
        } catch {
            failed = friendlyEditMessage(error)
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
