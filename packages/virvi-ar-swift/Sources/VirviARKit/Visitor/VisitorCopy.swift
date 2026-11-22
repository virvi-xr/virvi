import Foundation

// The words of apps/quest/app/src/main/java/io/virvi/ar/visitor/VisitorFlow.kt's `VisitorCopy`, word for word (the
// plan's Global Constraints), except `OFFLINE`, which names the phone. The headset-only strings (room scan, spatial
// data and its permission rationale, keep loaded, builder, sign out, the headset's occlusion modes) aren't used here.

/// The visitor's words, and the plain words for failures.
public enum VisitorCopy {
    public static let HINT = "Look for a ring like this, at eye level near the entrance."
    public static let TOO_FAR = "Step closer to the ring"
    public static let HOLD_STILL = "Hold still…"
    public static let STAND_IN_FRONT = "Stand in front of the ring"
    public static let NOT_SET_UP = "This space isn't set up yet"
    public static let LOOK_AGAIN = "Look at the ring again"
    public static let SPACES = "Spaces"
    public static let NO_SPACES = "No spaces yet"
    public static let LOOK_AT_RING = "Look at the ring when you get there"
    public static let CLOSE = "Close"

    /// The menu's report flow: the button, the reason picker, and the note after sending.
    public static let REPORT_SPACE = "Report this space"
    public static let REPORT_OFFENSIVE = "Offensive"
    public static let REPORT_UNSAFE = "Unsafe"
    public static let REPORT_SPAM = "Spam"
    public static let REPORT_OTHER = "Something else"
    public static let REPORT_CANCEL = "Cancel"
    public static let REPORT_SENT = "Thanks. Virvi will look at this space."
    public static let REPORT_RATE_LIMITED = "Too many reports from here. Try again later."
    public static let REPORT_FAILED = "Couldn't send the report. Check the connection and try again."

    public static func opening(_ spaceName: String?) -> String {
        spaceName.map { "Opening \($0)…" } ?? "Opening…"
    }

    public static let NOT_OPEN = "This space isn't open right now."
    public static let OFFLINE = "Can't reach Virvi. Check the phone's connection."
    public static let BUSY = "Virvi is busy. Trying again…"
    public static let COULDNT_OPEN = "Couldn't open this space. Try again in a moment."
    public static let BAD_DATA = "Something's wrong with this space's data."

    public static let NO_CAMERA = "Virvi AR needs camera access to find rings. Allow it in Settings → Apps → Virvi AR."
    public static let NO_WALL = "Can't see the wall behind this ring. Look around the room so the headset can map it."
}

/// The line the menu shows once a report has been tried.
public func reportNote(_ result: ReportResult) -> String {
    switch result {
    case .sent: return VisitorCopy.REPORT_SENT
    case .rateLimited: return VisitorCopy.REPORT_RATE_LIMITED
    case .failed: return VisitorCopy.REPORT_FAILED
    }
}
