import SwiftUI

/// "Roles" (hosts and co-hosts): who can work on this scene. No Make host: transfers stay on the dashboard.
struct RolesTab: View {
    let builder: SceneBuilder
    let onClose: () -> Void
    @State private var list = RolesList(hostWallets: [], roles: [])
    @State private var draftRole = "editor"
    @State private var draftWallet = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "Roles", subtitle: builder.scene.sceneName, onClose: onClose)
            VStack(alignment: .leading, spacing: 3) {
                if let error { Text(error).font(.system(size: 14)).foregroundStyle(Hud.danger) }
                ForEach(list.hostWallets.prefix(1), id: \.self) { w in
                    CardRow { Text("\(RolesModel.shortWallet(w)) — Host").font(.system(size: 16)).foregroundStyle(Hud.text) }
                }
                ForEach(list.roles, id: \.wallet) { r in
                    CardRow {
                        Text(r.title).font(.system(size: 16)).foregroundStyle(Hud.text).lineLimit(1)
                        Spacer()
                        HudButton(label: "Remove", color: Hud.danger, width: 90, height: 34, fontSize: 14) {
                            run { try await builder.roles.remove(wallet: r.wallet) }
                        }
                    }
                }
                Text(RolesModel.transferLine).font(.system(size: 14)).foregroundStyle(Hud.textDim).padding(.vertical, 4)
                Rectangle().fill(Hud.white08).frame(height: 1).padding(.vertical, 4)
                Text("Add as").font(.system(size: 15)).foregroundStyle(Hud.textDim)
                HStack(spacing: 8) {
                    ForEach(RolesModel.assignable, id: \.self) { role in
                        HudButton(label: RolesModel.roleLabel(role), color: draftRole == role ? Hud.accent : Hud.bgHover,
                                  height: 36, fontSize: 15) { draftRole = role }
                    }
                }
                TextField("or paste a wallet address (0x…)", text: $draftWallet)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.vertical, 6)
                HudButton(label: "Add address", color: Hud.accent, height: 40) {
                    let wallet = draftWallet.trimmingCharacters(in: .whitespaces)
                    guard wallet.range(of: #"^0x[0-9a-fA-F]{40}$"#, options: .regularExpression) != nil else {
                        error = "That is not a wallet address"; return
                    }
                    run {
                        try await builder.roles.add(wallet: wallet.lowercased(), role: draftRole)
                        draftWallet = ""
                    }
                }
            }
            .padding(12)
        }
        .task { await refresh() }
    }

    private func refresh() async {
        do { list = try await builder.roles.load(); error = nil } catch { self.error = friendlyRoleError(error) }
    }

    private func run(_ call: @escaping () async throws -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await call(); await refresh() } catch { self.error = friendlyRoleError(error) }
        }
    }
}
