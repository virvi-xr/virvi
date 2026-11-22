import Foundation

// Port of `hintText` and `lockingHint` from apps/quest/app/src/main/java/io/virvi/ar/visitor/HintCard.kt, and
// `menuButtonShown` from VisitorMenu.kt. The Quest's headset problems (permission dialogs, spatial data, room scan)
// become the phone's: camera access and the connection.

/// Something about the phone that stops rings being found or spaces opened, whatever the flow is doing.
public enum DeviceProblem: Sendable, Equatable {
    /// Camera access refused: no rings can be seen.
    case cameraDenied
    /// No network connection.
    case offline
}

/// What the hint card (and an open space page) says in `state`, or nil when it is hidden (the scene is shown). A device
/// `problem` comes first, since nothing else can help until it is fixed. While locking it follows `gather`;
/// `unreadableForMs` is how long an unreadable ring has been seen.
public func hintText(_ state: VisitorState, gather: GatherStatus = .noneInView, unreadableForMs: Int64 = 0,
                     problem: DeviceProblem? = nil) -> String? {
    if case .shown = state { return nil }
    switch problem {
    case .cameraDenied: return VisitorCopy.NO_CAMERA
    case .offline: return VisitorCopy.OFFLINE
    case nil: break
    }
    switch state {
    case .hint: return VisitorCopy.HINT
    case .stepCloser: return VisitorCopy.TOO_FAR
    case .loading(_, let spaceName): return VisitorCopy.opening(spaceName)
    case .locking: return lockingHint(gather, unreadableForMs: unreadableForMs)
    case .notSetUp: return VisitorCopy.NOT_SET_UP
    case .failed(let message): return message
    case .shown: return nil
    }
}

/// The hint while locking: "Hold still…" only while a ring of the space is actually being gathered. With none in view
/// (after a tracking jump or an interruption, a space opened from a link before arriving) it is the standard hint; a
/// ring too far away, or one seen but unreadable for `VisitorTuning.UNREADABLE_HINT_MS`, says step closer; a ring
/// holding still seen too far from head-on says to stand in front of it; a ring holding still with no wall heading says
/// the wall can't be seen.
public func lockingHint(_ gather: GatherStatus, unreadableForMs: Int64) -> String {
    switch gather {
    case .noneInView: return VisitorCopy.HINT
    case .gathering: return VisitorCopy.HOLD_STILL
    case .tooFar: return VisitorCopy.TOO_FAR
    case .unreadable: return unreadableForMs >= VisitorTuning.UNREADABLE_HINT_MS ? VisitorCopy.TOO_FAR : VisitorCopy.HINT
    case .noWall: return VisitorCopy.NO_WALL
    case .tooSteep: return VisitorCopy.STAND_IN_FRONT
    }
}

/// Whether the menu button shows: whenever a space is up, never on the plain hint.
public func menuButtonShown(_ state: VisitorState, spaceChosen: Bool) -> Bool {
    switch state {
    case .shown: return true
    case .locking, .notSetUp, .failed: return spaceChosen
    case .hint, .stepCloser, .loading: return false
    }
}
