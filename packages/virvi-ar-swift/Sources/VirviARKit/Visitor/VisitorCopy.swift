import Foundation

// The words of apps/quest/app/src/main/java/io/virvi/ar/visitor/VisitorFlow.kt's `VisitorCopy`, word for word (the
// plan's Global Constraints), except `OFFLINE` and `NO_WALL`, which name the phone (controller ruling for NO_WALL). The
// headset-only strings (room scan, spatial data and its permission rationale, keep loaded, builder, sign out, the
// headset's occlusion modes) aren't used here.

/// The visitor's words, and the plain words for failures.
public enum VisitorCopy {
    public static let HINT = "Look for an ARC like this, at eye level near the entrance."
    public static let TOO_FAR = "Step closer to the ARC"
    public static let HOLD_STILL = "Hold still…"
    public static let STAND_IN_FRONT = "Stand in front of the ARC"
    public static let NOT_SET_UP = "This space isn't set up yet"
    public static let LOOK_AGAIN = "Look at the ARC again"
    public static let SPACES = "Spaces"
    public static let NO_SPACES = "No spaces yet"
    public static let LOOK_AT_RING = "Look at the ARC when you get there"
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

    // BEATs in the app (the plan's Global Constraints, word for word)
    public static let BEAT_TRACK = "Track my attendance"
    public static let BEAT_SIGN_IN = "Sign in to earn this BEAT"
    public static let BEAT_CLAIM = "Claim your BEAT"
    public static let BEAT_WAITING = "Saved for you. Link a wallet at virvi.io and it'll be sent."
    public static let BEAT_POOR_FIX = "Couldn't get your location accurately. Step outside or near a window and try again."
    public static let BEAT_TRY_AGAIN = "Something went wrong. Try again in a moment."
    public static let BEAT_PHONE_CANT = "This phone can't earn BEATs."
    public static let THE_VENUE = "the venue"
    public static let MENU_SIGN_IN = "Sign in"
    public static let MENU_SIGN_OUT = "Sign out"
    public static let MENU_SIGN_HEADSET_IN = "Sign a headset in"

    public static func beatAttend(minutes: Int, name: String) -> String {
        "Attend for \(minutes) minutes to earn the \(name) BEAT."
    }
    public static func beatSent(name: String) -> String { "Your \(name) BEAT is in your wallet" }
    public static func beatOutsideClaim(venue: String) -> String { "Come back to \(venue) to claim this BEAT." }
    public static func beatOutsideCheckIn(venue: String) -> String { "You need to be at \(venue) to check in." }

    public static let NO_CAMERA = "Virvi needs camera access to find ARCs. Allow it in Settings → Apps → Virvi."
    public static let NO_WALL = "Can't see the wall behind this ARC. Look around the room so the phone can map it."
}

/// The line the menu shows once a report has been tried.
public func reportNote(_ result: ReportResult) -> String {
    switch result {
    case .sent: return VisitorCopy.REPORT_SENT
    case .rateLimited: return VisitorCopy.REPORT_RATE_LIMITED
    case .failed: return VisitorCopy.REPORT_FAILED
    }
}

/// The consent text's version, stored with each app claim: `BEAT_APP_CONSENT_VERSION` in packages/shared/src/beats.ts.
public let BEAT_APP_CONSENT_VERSION = 1

/// What the visitor agrees to before tracking a BEAT: `beatAppConsentText(name)` in packages/shared/src/beats.ts, word for word.
public func beatAppConsentText(_ name: String) -> String {
    "To track your attendance for the \(name) BEAT, Virvi stores your account, how long you're here and, when you claim, the wallet you choose. Virvi checks your location only when you check in and when you claim, and doesn't keep it. The hosts of this event will see your name, your time and, if you claim, the wallet you choose. If you claim, your wallet, this BEAT and the time it was sent are recorded on Polygon, a public blockchain: anyone can see that record, and nobody can delete it. You can stop tracking at any time before you claim, which deletes what was stored."
}
