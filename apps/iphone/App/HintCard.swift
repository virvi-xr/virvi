import SwiftUI
import VirviARKit

/// The card at the bottom of the camera view: a drawing of a ring marker and what to do (`VisitorController.hint`), or,
/// when a link has opened a space, the space page (its name, where its ring is, "Look at the ARC when you get there").
struct HintCard: View {
    let controller: VisitorController

    var body: some View {
        Group {
            if let beats = controller.beats, beats.visible {
                BeatCardView(model: beats)
            } else if let page = controller.spacePage {
                pageCard(spacePageLines(page, hint: controller.hint, problem: controller.spaceProblem))
            } else if let hint = controller.hint {
                hintCard(hint)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 12)
    }

    private func hintCard(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 14) {
                RingDrawing().frame(width: 72, height: 72)
                Text(text)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if controller.cameraDenied { settingsButton }
        }
        .padding(14)
        .background(Self.cardColor, in: RoundedRectangle(cornerRadius: 16))
    }

    private func pageCard(_ lines: SpacePageLines) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(lines.title).font(.system(size: 20, weight: .semibold)).foregroundStyle(.white)
            if let w = lines.whereText { Text(w).font(.system(size: 15)).foregroundStyle(Self.secondary) }
            Text(lines.instruction).font(.system(size: 15)).foregroundStyle(Self.secondary)
            if let h = lines.hint { Text(h).font(.system(size: 15, weight: .medium)).foregroundStyle(.white) }
            if controller.cameraDenied { settingsButton }
            Button(VisitorCopy.CLOSE) { controller.closeSpacePage() }
                .buttonStyle(.bordered)
                .tint(.white)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.cardColor, in: RoundedRectangle(cornerRadius: 16))
    }

    private var settingsButton: some View {
        Button("Open Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        .buttonStyle(.borderedProminent)
    }

    static let cardColor = Color(red: 0x10 / 255, green: 0x14 / 255, blue: 0x20 / 255).opacity(0.94)
    static let secondary = Color(white: 0.88)
}

/// A ring marker as printed (apps/ring-marker/ringmarker/layout.py): the finder ring with its gap at the top, three
/// rings of 24 cells, and the centre dot, on a light plaque. It draws a fixed demo id, never a real space's ring.
struct RingDrawing: View {
    /// A made-up id for the drawing only.
    private static let cells = RingCodec.encode(id: 0x5EED5EED)
    private static let finder: (CGFloat, CGFloat) = (62, 70)
    private static let codeRings: [(CGFloat, CGFloat)] = [(51, 59), (40, 48), (29, 37)] // ring 0 outermost
    private static let dot: CGFloat = 12
    private static let inset: Double = 1.2

    var body: some View {
        Canvas { ctx, size in
            let unit = min(size.width, size.height) / 150 // the plaque is 150 at the 140 reference diameter
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let ink = GraphicsContext.Shading.color(Color(white: 0.07))
            func arc(_ r0: CGFloat, _ r1: CGFloat, fromTopDeg: Double, sweepDeg: Double) {
                var p = Path()
                let start = Angle.degrees(fromTopDeg - 90) // y down: increasing angles run clockwise from 3 o'clock
                p.addArc(center: c, radius: (r0 + r1) / 2 * unit, startAngle: start,
                         endAngle: start + .degrees(sweepDeg), clockwise: false)
                ctx.stroke(p, with: ink, lineWidth: (r1 - r0) * unit)
            }
            arc(Self.finder.0, Self.finder.1, fromTopDeg: 8, sweepDeg: 344)
            for (ring, (r0, r1)) in Self.codeRings.enumerated() {
                for cell in 0..<24 where Self.cells[ring * 24 + cell] {
                    arc(r0, r1, fromTopDeg: Double(cell) * 15 + Self.inset, sweepDeg: 15 - 2 * Self.inset)
                }
            }
            let d = Self.dot * unit
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - d, y: c.y - d, width: 2 * d, height: 2 * d)), with: ink)
        }
        .background(Color(white: 0.95), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)
    }
}
