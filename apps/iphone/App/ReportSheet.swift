import SwiftUI
import VirviARKit

/// The report's reasons, in the Quest's order and words.
let REPORT_CHOICES: [(ReportReason, String)] = [
    (.offensive, VisitorCopy.REPORT_OFFENSIVE),
    (.unsafe, VisitorCopy.REPORT_UNSAFE),
    (.spam, VisitorCopy.REPORT_SPAM),
    (.other, VisitorCopy.REPORT_OTHER),
]

extension View {
    /// The reason picker for "Report this space": one button per reason and Cancel. `send` gets the reason picked; the
    /// menu then shows how it went (`reportNote`).
    func reportSheet(isPresented: Binding<Bool>, send: @escaping (ReportReason) -> Void) -> some View {
        confirmationDialog(VisitorCopy.REPORT_SPACE, isPresented: isPresented, titleVisibility: .visible) {
            ForEach(REPORT_CHOICES, id: \.0) { reason, label in
                Button(label) { send(reason) }
            }
            Button(VisitorCopy.REPORT_CANCEL, role: .cancel) {}
        }
    }
}
