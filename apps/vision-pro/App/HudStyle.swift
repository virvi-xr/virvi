import SwiftUI

/// The Decentraland HUD's palette (DclHUDRenderer `C`), so the window reads like the in-world panel.
enum Hud {
    static let bg = Color(red: 0.06, green: 0.06, blue: 0.1).opacity(0.96)
    static let bgLight = Color(red: 0.1, green: 0.1, blue: 0.16)
    static let bgHover = Color(red: 0.14, green: 0.14, blue: 0.2)
    static let bgCard = Color(red: 0.09, green: 0.09, blue: 0.14)
    static let text = Color.white
    static let textDim = Color(red: 0.55, green: 0.55, blue: 0.6)
    static let textMuted = Color(red: 0.4, green: 0.4, blue: 0.45)
    static let accent = Color(red: 0.35, green: 0.38, blue: 0.92)
    static let accentSoft = Color(red: 0.35, green: 0.38, blue: 0.92).opacity(0.15)
    static let success = Color(red: 0.18, green: 0.75, blue: 0.38)
    static let warning = Color(red: 0.88, green: 0.68, blue: 0.08)
    static let danger = Color(red: 0.88, green: 0.28, blue: 0.28)
    static let virvi = Color(red: 8 / 255, green: 221 / 255, blue: 235 / 255)
    static let white08 = Color.white.opacity(0.08)
}

/// DclHUDRenderer's PanelHeader: title, optional subtitle, and X.
struct PanelHeader: View {
    let title: String
    var subtitle: String?
    let onClose: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Hud.text)
                if let subtitle { Text(subtitle).font(.system(size: 14)).foregroundStyle(Hud.textDim) }
            }
            Spacer()
            Button(action: onClose) {
                Text("X").font(.system(size: 17)).foregroundStyle(Hud.textDim).frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .background(Hud.white08, in: RoundedRectangle(cornerRadius: 8))
            .hoverEffect()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .background(Hud.bgLight)
    }
}

/// DclHUDRenderer's Button: a flat block with a centred label.
struct HudButton: View {
    let label: String
    var color: Color = Hud.bgHover
    var textColor: Color = Hud.text
    var width: CGFloat?
    var height: CGFloat = 40
    var fontSize: CGFloat = 15
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: fontSize, weight: .medium))
                .foregroundStyle(textColor)
                .lineLimit(1)
                .frame(maxWidth: width ?? .infinity, minHeight: height)
                .frame(width: width)
        }
        .buttonStyle(.plain)
        .background(color, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 6))
        .hoverEffect()
    }
}

/// A one-line result under a panel header (DclHUDRenderer's EditMessage), with an optional action button.
struct EditLine: Equatable {
    var text: String
    var error: Bool
    var actionLabel: String?
    var actionUrl: URL?
}

struct EditLineView: View {
    let line: EditLine?
    var onAction: (URL) -> Void = { _ in }

    var body: some View {
        if let line {
            VStack(alignment: .leading, spacing: 6) {
                Text(line.text).font(.system(size: 14)).foregroundStyle(line.error ? Hud.danger : Hud.success)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let label = line.actionLabel, let url = line.actionUrl {
                    HudButton(label: label, color: Hud.accent, height: 36) { onAction(url) }
                }
            }
            .padding(.bottom, 6)
        }
    }
}

/// The centred empty state of each panel, with an optional hint line under it.
struct EmptyPanel: View {
    let text: String
    var hint: String?

    var body: some View {
        VStack(spacing: 6) {
            Text(text).font(.system(size: 17)).foregroundStyle(Hud.textDim)
            if let hint { Text(hint).font(.system(size: 14)).foregroundStyle(Hud.textMuted) }
        }
        .frame(maxWidth: .infinity)
        .padding(24)
    }
}

/// A row on the panel's card colour.
struct CardRow<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        HStack(spacing: 8) { content }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
            .background(Hud.bgCard)
    }
}
