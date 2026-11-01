import SwiftUI

/// The Decentraland edit bar (packages/adapter-dcl/src/hud/EditModeBar.tsx) as an ornament under the HUD window:
/// Move | Rotate | Resize, the selected name (or how to pick one), Move's axis lock, Snap, Exact,
/// Save, Revert and Done, bound to `EditSession`; above it the held line, the error message, the "Save or revert" prompt
/// and the Exact panel. All of that shows only while editing (Done stops). Under it, always while the scene is in the
/// room, the Place controls (Done placing / Move scene, Pin, Re-place).
struct EditBarView: View {
    @ObservedObject var space: BuildSpace
    @ObservedObject var edit: EditSession
    @State private var typed: [Int: String] = [:]
    @State private var typedFor = ""

    /// EditModeBar's LOCK_COLORS.
    private static func lockColor(_ l: AxisLock) -> Color {
        switch l {
        case .free: Color(red: 0.75, green: 0.75, blue: 0.8)
        case .x: Color(red: 0.92, green: 0.3, blue: 0.3)
        case .y: Color(red: 0.3, green: 0.85, blue: 0.4)
        case .z: Color(red: 0.35, green: 0.55, blue: 0.95)
        }
    }

    private static func lockLabel(_ l: AxisLock) -> String {
        switch l {
        case .free: "Free"
        case .x: "X"
        case .y: "Y"
        case .z: "Z"
        }
    }

    private var prompt: Bool { edit.message?.hasPrefix("Save or revert changes to") == true }

    var body: some View {
        VStack(spacing: 6) {
            if space.editing { editing }
            placeRow
        }
        .frame(width: 940)
        .onChange(of: "\(edit.selected?.name ?? ""):\(edit.mode.rawValue)") { _, key in
            // Typed text is dropped when the selection or mode changes.
            if key != typedFor { typedFor = key; typed = [:] }
        }
    }

    @ViewBuilder private var editing: some View {
        // The held line stays up on its own, with the prompt or any other message beside it.
        if let held = edit.heldLine {
            Text(held).font(.system(size: 14)).foregroundStyle(Hud.warning)
                .padding(.horizontal, 16).padding(.vertical, 6).background(Hud.bg, in: RoundedRectangle(cornerRadius: 6))
        }
        if let message = edit.message, !prompt {
            Text(message).font(.system(size: 14)).foregroundStyle(Hud.warning)
                .padding(.horizontal, 16).padding(.vertical, 6).background(Hud.bg, in: RoundedRectangle(cornerRadius: 6))
        }
        if prompt { promptPanel }
        if space.exactOpen, edit.selected != nil { exactPanel }
        bar
    }

    private var bar: some View {
        HStack(spacing: 6) {
            ForEach([EditMode.move, .rotate, .resize], id: \.self) { m in
                BarButton(label: m.rawValue, width: 92, color: edit.mode == m ? Hud.accent : Hud.bgHover) { edit.mode = m }
            }
            Text(selectionLabel(placing: space.phase == .place, selectedName: edit.selected?.name))
                .font(.system(size: 15)).foregroundStyle(edit.selected != nil ? Hud.text : Hud.textMuted)
                .lineLimit(2).minimumScaleFactor(0.8).frame(width: 190).padding(.horizontal, 4)
            if edit.mode == .move {
                Button { edit.cycleLock() } label: {
                    Text(Self.lockLabel(edit.lock)).font(.system(size: 16, weight: .semibold)).foregroundStyle(Self.lockColor(edit.lock))
                        .frame(width: 52, height: 40)
                }
                .buttonStyle(.plain).hoverEffect()
            }
            Spacer(minLength: 0)
            BarButton(label: "Snap", width: 70, color: edit.snap ? Hud.accent : Hud.bgHover) { edit.snap.toggle() }
            BarButton(label: "Exact", width: 70, color: space.exactOpen ? Hud.accent : Hud.bgHover, off: edit.selected == nil) {
                space.exactOpen.toggle()
            }
            BarButton(label: "Save", width: 70, color: Hud.accent, off: !edit.saveEnabled) { Task { await edit.save() } }
            BarButton(label: "Revert", width: 74, color: Hud.danger, off: !edit.revertEnabled) { edit.revert() }
            BarButton(label: "Done", width: 70, color: Hud.bgHover) { if edit.done() { space.editing = false } }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Hud.bg, in: RoundedRectangle(cornerRadius: 8))
    }

    private var promptPanel: some View {
        VStack(spacing: 8) {
            Text("Save or revert changes to \(edit.selected?.name ?? "this item") first.").font(.system(size: 15)).foregroundStyle(Hud.text)
            HStack(spacing: 6) {
                BarButton(label: "Save", width: 100, color: Hud.accent, off: !edit.saveEnabled) { Task { await edit.save() } }
                BarButton(label: "Revert", width: 100, color: Hud.danger, off: !edit.revertEnabled) { edit.revert() }
            }
        }
        .padding(12).frame(width: 520).background(Hud.bg, in: RoundedRectangle(cornerRadius: 8))
    }

    private var exactPanel: some View {
        let current = values
        return VStack(alignment: .leading, spacing: 6) {
            Text("\(exactTitle(edit.mode)) — type a value and press Enter").font(.system(size: 13)).foregroundStyle(Hud.textMuted)
            HStack(spacing: 14) {
                ForEach(0..<3, id: \.self) { axis in
                    HStack(spacing: 6) {
                        Text(["X", "Y", "Z"][axis]).font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Self.lockColor([AxisLock.x, .y, .z][axis]))
                        TextField(formatExact(current[axis]), text: Binding(
                            get: { typed[axis] ?? formatExact(current[axis]) },
                            set: { typed[axis] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder).frame(width: 150)
                        .onSubmit { apply([axis]) }
                    }
                }
                Spacer(minLength: 0)
                BarButton(label: "Apply", width: 84, color: Hud.accent, off: edit.saving) { apply([0, 1, 2]) }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Hud.bg, in: RoundedRectangle(cornerRadius: 8))
    }

    /// The current mode's live values.
    private var values: SIMD3<Double> {
        guard let t = edit.selected?.current else { return .zero }
        switch edit.mode {
        case .move: return t.position
        case .rotate: return t.rotation
        case .resize: return t.scale
        }
    }

    /// Applies the typed axes; anything that doesn't parse shows the old value again.
    private func apply(_ axes: [Int]) {
        var pick: [Int: String] = [:]
        for a in axes { if let t = typed.removeValue(forKey: a) { pick[a] = t } }
        if let v = exactValue(values, typed: pick) { edit.exact(ExactField(edit.mode), v) }
    }

    /// The spike's Place scene controls: the floor disc and outline move the scene only while Place scene is on.
    private var placeRow: some View {
        HStack(spacing: 8) {
            BarButton(label: space.phase == .place ? "Done placing" : "Move scene", width: 130,
                      color: space.phase == .place ? Hud.accent : Hud.bgHover) {
                space.phase = space.phase == .place ? .edit : .place
            }
            BarButton(label: "Pin to this room", width: 170, color: Hud.bgHover) { Task { await space.pin() } }
            BarButton(label: "Re-place", width: 100, color: Hud.bgHover) { Task { await space.replace() } }
            Text(space.phase == .place
                 ? "Pinch and drag the floor marker or the outline to move the scene. Pinch with both hands on the marker and twist to turn it."
                 : space.pinStatus)
                .font(.system(size: 13)).foregroundStyle(Hud.textDim).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Hud.bg.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// EditModeBar's `Btn`: flat, with a dim label when it's off.
private struct BarButton: View {
    let label: String
    let width: CGFloat
    var color: Color = Hud.bgHover
    var off = false
    let action: () -> Void

    var body: some View {
        Button { if !off { action() } } label: {
            Text(label).font(.system(size: 15, weight: .medium)).foregroundStyle(off ? Hud.textMuted : Hud.text)
                .lineLimit(1).frame(width: width, height: 40)
        }
        .buttonStyle(.plain)
        .background(off ? Hud.bgCard : color, in: RoundedRectangle(cornerRadius: 6))
        .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 6))
        .hoverEffect()
        .disabled(off)
    }
}
