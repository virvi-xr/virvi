import Foundation
import Observation
import UserNotifications
import VirviARKit

/// The local "claim your BEAT" reminder (`UNUserNotificationCenter` on the phone; a fake in tests).
@MainActor
protocol ClaimNotifier: AnyObject {
    func requestPermission() async
    /// Replaces any reminder already set for `beatId`.
    func schedule(beatId: String, name: String, atMs: Int64)
    func cancel(beatId: String)
}

@MainActor
final class SystemClaimNotifier: ClaimNotifier {
    private let center = UNUserNotificationCenter.current()

    func requestPermission() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound])
    }

    func schedule(beatId: String, name: String, atMs: Int64) {
        let content = UNMutableNotificationContent()
        content.title = "Virvi"
        content.body = "Claim your \(name) BEAT"
        content.sound = .default
        content.userInfo = [Self.beatIdKey: beatId]
        let seconds = max(1, Double(atMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
        center.add(UNNotificationRequest(identifier: Self.id(beatId), content: content, trigger: trigger))
    }

    func cancel(beatId: String) {
        center.removePendingNotificationRequests(withIdentifiers: [Self.id(beatId)])
    }

    static let beatIdKey = "beatId"
    private static func id(_ beatId: String) -> String { "beat-claim-\(beatId)" }
}

/// The BEAT a "claim your BEAT" reminder is for, from its `userInfo`; nil for any other notification.
func beatId(fromNotification userInfo: [AnyHashable: Any]) -> String? {
    guard let id = userInfo[SystemClaimNotifier.beatIdKey] as? String, !id.isEmpty else { return nil }
    return id
}

/// Shows the reminder while the app is open too, and opens its BEAT's card when it is tapped.
final class ClaimNotificationRouter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    private let open: @MainActor (String) -> Void

    init(open: @escaping @MainActor (String) -> Void) { self.open = open }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = beatId(fromNotification: response.notification.request.content.userInfo)
        let open = open
        DispatchQueue.main.async {
            MainActor.assumeIsolated { if let id { open(id) } }
            completionHandler()
        }
    }
}

/// Where the BEAT on the card came from: the AR space that is shown, an event ARC that was scanned, or the visitor's own
/// list (My BEATs, or the reminder).
enum BeatOrigin: Equatable {
    case space(String)
    case arc(code: String)
    case beat(String)

    /// The card isn't tied to a space being in view: it stays until it is closed.
    var isEvent: Bool {
        if case .space = self { return false }
        return true
    }
}

/// The BEAT card's behaviour: which BEAT it shows, tracking, check-ins while a space is shown, claiming (with the
/// wallet choice and the location check), the reminder, and asking for the card again when an in-person claim's time is
/// up (one scan only: the visitor never scans again to claim). `BeatCard` (the package) decides what it says. Main
/// thread only.
@MainActor
@Observable
final class BeatModel {
    static let checkInIntervalS: Double = 30
    static let NO_LOCATION = "Virvi needs your location to check you're at the event. Allow it in Settings → Apps → Virvi."
    static let STOP_TRACKING = "Stop tracking"
    static let NEEDS_PRECISE = "Turn on Precise Location for Virvi in Settings to check in at the event."
    static let RETRY = "Try again"
    static let AGREE = "I agree"

    private(set) var card = BeatCard()
    /// The consent text waiting for the visitor's answer, or nil.
    private(set) var consentText: String?
    /// An event ARC was scanned signed out: its BEAT's name, with the one way on being to sign in.
    private(set) var signInName: String?
    /// The card is showing a location refusal: the visitor can open Settings.
    private(set) var locationDenied = false
    private(set) var origin: BeatOrigin?
    /// The BEAT on the card, as the server last gave it.
    private(set) var current: AppBeatCard?

    /// Set by the app: starts the sign-in.
    @ObservationIgnored var signIn: () -> Void = {}

    @ObservationIgnored private let api: AppBeatApi
    @ObservationIgnored private let session: AppSession
    @ObservationIgnored private let location: LocationProvider
    @ObservationIgnored private let notifier: ClaimNotifier
    @ObservationIgnored private let wallClock: () -> Int64
    @ObservationIgnored private let sleep: @Sendable (Double) async -> Void
    @ObservationIgnored private var checkIns: Task<Void, Never>?
    /// The card is asked for again when an in-person claim's time is up.
    @ObservationIgnored private var refetch: Task<Void, Never>?
    /// The space whose card this is, while it is shown or locking again after a moment's loss of tracking.
    @ObservationIgnored private var shownSpaceId: String?
    /// Whether that space is in view now (not locking again).
    @ObservationIgnored private var spaceInView = false
    /// The BEAT whose space reminder is set for this showing of the space.
    @ObservationIgnored private var spaceReminder: String?
    @ObservationIgnored private var askedPermission = false
    /// What the visitor last tried on this card, for "Try again".
    @ObservationIgnored private var lastAction: Action?
    private enum Action { case track, claim(wallet: String?) }
    /// A track the consent text is holding.
    @ObservationIgnored private var tracksAfterConsent = false
    /// Bumped whenever the card is replaced from outside (a new space, a new ARC), so a late answer for the old one is dropped.
    @ObservationIgnored private var generation = 0

    init(api: AppBeatApi, session: AppSession, location: LocationProvider, notifier: ClaimNotifier,
         wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.api = api
        self.session = session
        self.location = location
        self.notifier = notifier
        self.wallClock = wallClock
        self.sleep = sleep
    }

    /// Asks the server what an ARC is (a space's, or an event's).
    func lookupArc(_ code: String) async -> AppBeatResult<AppArc> { await api.arc(code) }

    /// The card is on screen.
    var visible: Bool { card.state != .hidden || signInName != nil }

    func stop() {
        stopCheckIns()
        stopRefetch()
    }

    // MARK: - What the card is for

    /// The space chosen now (nil: none is), and whether it is in view (`shown`) or locking again. A shown space with a
    /// BEAT shows its card and checks in every 30 s. Losing the ring for a moment (the same space locking again) keeps
    /// the card and its timer; only another space, Look again or leaving the space clears them.
    func spaceChanged(_ spaceId: String?, shown: Bool) {
        if let spaceId, spaceId == shownSpaceId {
            guard shown != spaceInView else { return }
            spaceInView = shown
            // Time in a space counts only while it is in view: its reminder waits for the next check-in in view
            if !shown { cancelSpaceReminder() }
            return
        }
        // A space not yet shown has no card yet
        let next = shown ? spaceId : nil
        guard next != shownSpaceId else { return }
        cancelSpaceReminder()
        shownSpaceId = next
        spaceInView = next != nil
        lastAction = nil
        stopCheckIns()
        generation += 1
        // A space's card goes with the space; an event's stays until it is closed
        if case .space = origin { clearCard() }
        guard let next else { return }
        stopRefetch()
        origin = .space(next)
        let gen = generation
        Task {
            let r = await api.spaceBeat(next)
            guard gen == generation else { return }
            if case .ok(let found) = r { show(found) } else { clearCard() }
        }
    }

    /// An event's ARC was scanned: its card (the caller's own claim with it), or, signed out, its name and the way to sign in.
    func openEvent(code: String, name: String, card: AppBeatCard?) {
        replaceFromOutside(.arc(code: code))
        if let card { show(card) }
        else {
            self.card = BeatCard()
            current = nil
            signInName = name
        }
    }

    /// Opens one of the visitor's own BEATs (a My BEATs row): its card, with "Claim your BEAT" once it can be claimed.
    func openBeat(_ found: AppBeatCard) {
        replaceFromOutside(.beat(found.beatId))
        show(found)
    }

    /// Opens a BEAT by its id (a tapped reminder): asks for the visitor's card first.
    func openBeat(id: String) async {
        let gen = generation
        guard case .ok(let found?) = await api.beat(id), gen == generation else { return }
        openBeat(found)
    }

    private func replaceFromOutside(_ next: BeatOrigin) {
        generation += 1
        stopCheckIns()
        stopRefetch()
        cancelSpaceReminder()
        origin = next
        lastAction = nil
        locationDenied = false
        signInName = nil
    }

    /// Closes the card of an event (or of one of the visitor's BEATs).
    func closeEvent() {
        guard origin?.isEvent == true else { return }
        generation += 1
        clearCard()
    }

    /// The app is back in the foreground: an in-person claim may have finished counting while it was away.
    func appBecameActive() {
        guard origin?.isEvent == true, current?.claim?.status == "present" else { return }
        refetchNow()
    }

    /// The visitor has signed in or out: the card is asked for again as the new account.
    func accountChanged() {
        switch origin {
        case .space?:
            guard let id = shownSpaceId else { return }
            let inView = spaceInView
            shownSpaceId = nil
            spaceChanged(id, shown: true)
            if !inView { spaceChanged(id, shown: false) }
        case .arc(let code)?:
            let gen = generation
            Task {
                guard case .ok(.beat(_, let name, let card)) = await api.arc(code), gen == generation else { return }
                openEvent(code: code, name: name, card: card)
            }
        case .beat(let id)?:
            guard session.signedIn else { generation += 1; return clearCard() }
            Task { await openBeat(id: id) }
        case nil: break
        }
    }

    private func show(_ found: AppBeatCard?) {
        current = found
        signInName = nil
        locationDenied = false
        card.apply(found, signedIn: session.signedIn, nowMs: wallClock())
        syncCheckIns()
        syncRefetch()
    }

    private func clearCard() {
        current = nil
        signInName = nil
        locationDenied = false
        card = BeatCard()
        origin = nil
        stopCheckIns()
        stopRefetch()
    }

    // MARK: - Tracking

    /// The card's button for its state.
    func primaryAction() {
        switch card.state {
        case .signInToEarn: signIn()
        case .track: track()
        case .claimable: claim(wallet: nil)
        default: break
        }
    }

    /// Whether the card offers "Try again": it says something went wrong and there is something to do again.
    var canRetry: Bool {
        switch card.state {
        case .poorFix, .outside, .failed: return current != nil
        default: return false
        }
    }

    /// Does again what the visitor last tried, or shows the card as the server last gave it.
    func retry() {
        switch lastAction {
        case .track?: track()
        case .claim(let wallet)?: claim(wallet: wallet)
        case nil: show(current)
        }
    }

    /// Every Track shows the consent text first, as in-world does.
    private func track() {
        guard let current, session.signedIn else { return }
        lastAction = .track
        consentText = beatAppConsentText(current.name)
        tracksAfterConsent = true
    }

    func acceptConsent() {
        consentText = nil
        guard tracksAfterConsent, let current else { return }
        tracksAfterConsent = false
        Task { await startTracking(current) }
    }

    func declineConsent() {
        consentText = nil
        tracksAfterConsent = false
    }

    private func startTracking(_ beat: AppBeatCard) async {
        guard let via = await trackVia(beat) else { return }
        let gen = generation
        let r = await api.track(beat.beatId, via: via)
        guard gen == generation else { return }
        switch r {
        case .ok(let updated):
            show(updated)
            // In person, tracking is the check-in: the minutes count from now (or the start), so the reminder does too
            if case .arc = via { await remindEvent(updated) }
        case .error(let e): card.apply(error: e)
        }
    }

    /// Where tracking starts from, with the location a pinned event needs; nil when the card now says why not.
    private func trackVia(_ beat: AppBeatCard) async -> BeatVia? {
        switch origin {
        case .space(let id)?: return .space(id)
        case .arc(let code)?:
            guard let fix = await locationIfNeeded(beat) else { return nil }
            return .arc(code: code, location: fix.location)
        case .beat?, nil: return nil
        }
    }

    /// The fix a BEAT with a venue pin needs when its event ARC was scanned here (a `Fix` with no location when none is
    /// needed: no pin, a space's card, or one of the visitor's own BEATs, whose claim may have no event check-in; the
    /// server's `location_needed` then asks for one), nil when it couldn't be had (the card says why).
    private func locationIfNeeded(_ beat: AppBeatCard) async -> Fix? {
        guard beat.pinned, case .arc? = origin else { return Fix(location: nil) }
        return await locationFix()
    }

    private func locationFix() async -> Fix? {
        locationDenied = false
        switch await location.fix() {
        case .fix(let l): return Fix(location: l)
        case .denied:
            locationDenied = true
            card.apply(error: AppBeatError(status: 0, code: "no_location", message: Self.NO_LOCATION))
        case .reduced:
            locationDenied = true
            card.apply(error: AppBeatError(status: 0, code: "no_precise_location", message: Self.NEEDS_PRECISE))
        case .unavailable: card.apply(error: AppBeatError(status: 0, code: "poor_fix", message: VisitorCopy.BEAT_POOR_FIX))
        }
        return nil
    }

    private struct Fix { var location: BeatLocation? }

    func stopTracking() {
        guard let current else { return }
        let gen = generation
        Task {
            let r = await api.stopTracking(current.beatId)
            guard gen == generation else { return }
            switch r {
            case .ok:
                notifier.cancel(beatId: current.beatId)
                if spaceReminder == current.beatId { spaceReminder = nil }
                var fresh = current
                fresh.claim = nil
                show(fresh)
            case .error(let e): card.apply(error: e)
            }
        }
    }

    // MARK: - Claiming

    /// Claims the BEAT; `wallet` is the one the visitor chose when the account has several. Only the BEAT's id and,
    /// with a pin, a location fix are needed: never another scan.
    func claim(wallet: String?) {
        guard let current else { return }
        lastAction = .claim(wallet: wallet)
        card.beginClaim()
        let gen = generation
        Task {
            guard let fix = await locationIfNeeded(current) else { return }
            var r = await api.claim(current.beatId, wallet: wallet, location: fix.location)
            // A claim with an event check-in (a space's, or one opened from My BEATs) is checked at the venue, as the server says
            if case .error(let e) = r, e.code == "location_needed", fix.location == nil, current.pinned {
                guard gen == generation, let again = await locationFix() else { return }
                r = await api.claim(current.beatId, wallet: wallet, location: again.location)
            }
            guard gen == generation else { return }
            switch r {
            case .ok(let updated):
                notifier.cancel(beatId: current.beatId)
                show(updated)
            case .error(let e): card.apply(error: e)
            }
        }
    }

    // MARK: - Asking again when the time is up

    /// Never asked for again sooner than this: a card whose time can't grow here would otherwise be asked every second.
    static let refetchFloorS: Double = 30

    /// An in-person card that is counting is asked for again when its time is up (`beatClaimDueMs`, at least 30 s on),
    /// so it offers "Claim your BEAT" without another scan.
    private func syncRefetch() {
        stopRefetch()
        guard origin?.isEvent == true, case .counting = card.state, let beat = current else { return }
        let now = wallClock()
        guard let due = beatClaimDueMs(beat, nowMs: now) else { return }
        let seconds = max(Self.refetchFloorS, Double(due - now) / 1000)
        let sleep = sleep
        refetch = Task { [weak self] in
            await sleep(seconds)
            if Task.isCancelled { return }
            self?.refetchNow()
        }
    }

    /// Asks for the card again. One that came back with no progress and still counting (a space's BEAT away from its
    /// space, or a claim past its end) isn't asked for again by itself; coming back to the app or opening it still does.
    private func refetchNow() {
        guard let id = current?.beatId else { return }
        let before = current?.claim?.secondsPresent
        let gen = generation
        Task {
            guard case .ok(let found?) = await api.beat(id), gen == generation else { return }
            show(found)
            if case .counting = card.state, found.claim?.secondsPresent == before { stopRefetch() }
        }
    }

    private func stopRefetch() {
        refetch?.cancel()
        refetch = nil
    }

    // MARK: - Check-ins and the reminder

    /// The check-in timer runs only while the chosen space's BEAT is being counted. It keeps running while the space
    /// locks again after a moment's loss of tracking, and checks in only while the space is in view.
    private func syncCheckIns() {
        guard case .space(let id)? = origin, id == shownSpaceId, case .counting = card.state else { return stopCheckIns() }
        if checkIns != nil { return }
        let sleep = sleep
        checkIns = Task { [weak self] in
            while !Task.isCancelled {
                await sleep(Self.checkInIntervalS)
                if Task.isCancelled { return }
                await self?.checkIn()
            }
        }
    }

    private func stopCheckIns() {
        checkIns?.cancel()
        checkIns = nil
    }

    private func checkIn() async {
        guard case .space(let id)? = origin, id == shownSpaceId, spaceInView, let beat = current else { return }
        let gen = generation
        let r = await api.checkIn(beat.beatId, spaceId: id)
        guard gen == generation else { return }
        switch r {
        case .ok(let updated):
            show(updated)
            if spaceInView { await remindSpace(updated) }
        case .error(let e):
            // A phone that dropped offline for a moment just checks in at the next tick; any other failure is shown and ends the loop
            guard e.code != "offline" else { return }
            card.apply(error: e)
            stopCheckIns()
        }
    }

    /// At the first check-in of each showing of a space: the reminder for the minutes still left, if the visitor stays.
    private func remindSpace(_ beat: AppBeatCard) async {
        guard spaceReminder != beat.beatId, beat.minMinutes > 0, let left = beatSecondsLeft(beat), left > 0 else { return }
        spaceReminder = beat.beatId
        await askPermission()
        notifier.schedule(beatId: beat.beatId, name: beat.name, atMs: wallClock() + Int64(left) * 1000)
    }

    private func cancelSpaceReminder() {
        guard let id = spaceReminder else { return }
        spaceReminder = nil
        notifier.cancel(beatId: id)
    }

    /// An in-person check-in: the reminder for when the time is up, counted from now or the BEAT's start.
    private func remindEvent(_ beat: AppBeatCard) async {
        let now = wallClock()
        guard beat.minMinutes > 0, let due = beatClaimDueMs(beat, nowMs: now), due > now else { return }
        await askPermission()
        notifier.schedule(beatId: beat.beatId, name: beat.name, atMs: due)
    }

    private func askPermission() async {
        if askedPermission { return }
        askedPermission = true
        await notifier.requestPermission()
    }
}
