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
        let seconds = max(1, Double(atMs - Int64(Date().timeIntervalSince1970 * 1000)) / 1000)
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
        center.add(UNNotificationRequest(identifier: Self.id(beatId), content: content, trigger: trigger))
    }

    func cancel(beatId: String) {
        center.removePendingNotificationRequests(withIdentifiers: [Self.id(beatId)])
    }

    private static func id(_ beatId: String) -> String { "beat-claim-\(beatId)" }
}

/// Whether this account has accepted the app's consent text, kept on the phone (the server also records the version at each track).
protocol BeatConsentStore {
    func accepted(account: String) -> Bool
    func accept(account: String)
}

struct UserDefaultsBeatConsentStore: BeatConsentStore {
    var defaults: UserDefaults = .standard

    private func key(_ account: String) -> String { "io.virvi.app.beat-consent.\(account)" }
    func accepted(account: String) -> Bool { defaults.integer(forKey: key(account)) == BEAT_APP_CONSENT_VERSION }
    func accept(account: String) { defaults.set(BEAT_APP_CONSENT_VERSION, forKey: key(account)) }
}

/// The account's id from its access token (the `id` claim), only to key what the phone remembers per account; the token
/// is not verified here. Nil for anything that isn't a token with one.
func accountId(fromAccessToken token: String?) -> String? {
    guard let token else { return nil }
    let parts = token.split(separator: ".")
    guard parts.count == 3 else { return nil }
    var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = o["id"] as? String, !id.isEmpty else { return nil }
    return id
}

/// Where the BEAT on the card came from: the AR space that is shown, or an event ARC that was scanned.
enum BeatOrigin: Equatable {
    case space(String)
    case arc(code: String)
}

/// The BEAT card's behaviour: which BEAT it shows, tracking, check-ins while a space is shown, claiming (with the
/// wallet choice and the location check), and the reminder. `BeatCard` (the package) decides what it says. Main thread only.
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
    @ObservationIgnored private let consent: BeatConsentStore
    @ObservationIgnored private let wallClock: () -> Int64
    @ObservationIgnored private let sleep: @Sendable (Double) async -> Void
    @ObservationIgnored private var checkIns: Task<Void, Never>?
    @ObservationIgnored private var shownSpaceId: String?
    @ObservationIgnored private var reminded: Set<String> = []
    /// What the visitor last tried on this card, for "Try again".
    @ObservationIgnored private var lastAction: Action?
    private enum Action { case track, claim(wallet: String?) }
    /// A track the consent text is holding.
    @ObservationIgnored private var tracksAfterConsent = false
    /// Bumped whenever the card is replaced from outside (a new space, a new ARC), so a late answer for the old one is dropped.
    @ObservationIgnored private var generation = 0

    init(api: AppBeatApi, session: AppSession, location: LocationProvider, notifier: ClaimNotifier,
         consent: BeatConsentStore = UserDefaultsBeatConsentStore(),
         wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
         sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.api = api
        self.session = session
        self.location = location
        self.notifier = notifier
        self.consent = consent
        self.wallClock = wallClock
        self.sleep = sleep
    }

    /// Asks the server what an ARC is (a space's, or an event's).
    func lookupArc(_ code: String) async -> AppBeatResult<AppArc> { await api.arc(code) }

    /// The card is on screen.
    var visible: Bool { card.state != .hidden || signInName != nil }

    func stop() {
        checkIns?.cancel()
        checkIns = nil
    }

    // MARK: - What the card is for

    /// The space now shown changes (nil: none is). A shown space with a BEAT shows its card, and checks in every 30 s.
    func spaceShown(_ spaceId: String?) {
        guard spaceId != shownSpaceId else { return }
        shownSpaceId = spaceId
        lastAction = nil
        checkIns?.cancel()
        checkIns = nil
        generation += 1
        // A space's card goes with the space; an event's stays until it is closed
        if case .space = origin { clearCard() }
        guard let spaceId else { return }
        origin = .space(spaceId)
        let gen = generation
        Task {
            let r = await api.spaceBeat(spaceId)
            guard gen == generation else { return }
            if case .ok(let found) = r { show(found) } else { clearCard() }
        }
    }

    /// An event's ARC was scanned: its card (the caller's own claim with it), or, signed out, its name and the way to sign in.
    func openEvent(code: String, name: String, card: AppBeatCard?) {
        generation += 1
        checkIns?.cancel()
        checkIns = nil
        origin = .arc(code: code)
        lastAction = nil
        locationDenied = false
        if let card { signInName = nil; show(card) }
        else {
            self.card = BeatCard()
            current = nil
            signInName = name
        }
    }

    /// Closes the card of an event.
    func closeEvent() {
        guard case .arc = origin else { return }
        generation += 1
        clearCard()
    }

    /// The visitor has signed in or out: the card is asked for again as the new account.
    func accountChanged() {
        switch origin {
        case .space?:
            guard let id = shownSpaceId else { return }
            shownSpaceId = nil
            spaceShown(id)
        case .arc(let code)?:
            let gen = generation
            Task {
                guard case .ok(.beat(_, let name, let card)) = await api.arc(code), gen == generation else { return }
                openEvent(code: code, name: name, card: card)
            }
        case nil: break
        }
    }

    private func show(_ found: AppBeatCard?) {
        current = found
        signInName = nil
        locationDenied = false
        card.apply(found, signedIn: session.signedIn, nowMs: wallClock())
        syncCheckIns()
    }

    private func clearCard() {
        current = nil
        signInName = nil
        locationDenied = false
        card = BeatCard()
        origin = nil
        checkIns?.cancel()
        checkIns = nil
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

    private func track() {
        guard let current, session.signedIn else { return }
        lastAction = .track
        Task {
            if !(await hasConsented()) {
                consentText = beatAppConsentText(current.name)
                tracksAfterConsent = true
                return
            }
            await startTracking(current)
        }
    }

    func acceptConsent() {
        consentText = nil
        guard tracksAfterConsent, let current else { return }
        tracksAfterConsent = false
        Task {
            if let account = accountId(fromAccessToken: await session.bearer()) { consent.accept(account: account) }
            await startTracking(current)
        }
    }

    func declineConsent() {
        consentText = nil
        tracksAfterConsent = false
    }

    private func hasConsented() async -> Bool {
        guard let account = accountId(fromAccessToken: await session.bearer()) else { return false }
        return consent.accepted(account: account)
    }

    private func startTracking(_ beat: AppBeatCard) async {
        guard let via = await trackVia(beat) else { return }
        let gen = generation
        let r = await api.track(beat.beatId, via: via)
        guard gen == generation else { return }
        switch r {
        case .ok(let updated):
            show(updated)
            // In person, tracking is the check-in: the minutes count from now, so the reminder does too
            if case .arc = via { await remind(updated, atMs: wallClock()) }
        case .error(let e): card.apply(error: e)
        }
    }

    /// Where tracking starts from, with the location an in-person event needs; nil when the card now says why not.
    private func trackVia(_ beat: AppBeatCard) async -> BeatVia? {
        switch origin {
        case .space(let id)?: return .space(id)
        case .arc(let code)?:
            guard let fix = await locationIfNeeded(beat) else { return nil }
            return .arc(code: code, location: fix.location)
        case nil: return nil
        }
    }

    /// The fix an event at a venue needs (a `Fix` with no location when none is needed), nil when it couldn't be had (the card says why).
    private func locationIfNeeded(_ beat: AppBeatCard) async -> Fix? {
        guard case .arc? = origin, beat.locationType == "in_person" else { return Fix(location: nil) }
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
                reminded.remove(current.beatId)
                var fresh = current
                fresh.claim = nil
                show(fresh)
            case .error(let e): card.apply(error: e)
            }
        }
    }

    // MARK: - Claiming

    /// Claims the BEAT; `wallet` is the one the visitor chose when the account has several.
    func claim(wallet: String?) {
        guard let current else { return }
        lastAction = .claim(wallet: wallet)
        card.beginClaim()
        let gen = generation
        Task {
            guard let fix = await locationIfNeeded(current) else { return }
            let r = await api.claim(current.beatId, wallet: wallet, location: fix.location)
            guard gen == generation else { return }
            switch r {
            case .ok(let updated):
                notifier.cancel(beatId: current.beatId)
                show(updated)
            case .error(let e): card.apply(error: e)
            }
        }
    }

    // MARK: - Check-ins and the reminder

    /// The check-in timer runs only while the shown space's BEAT is being counted.
    private func syncCheckIns() {
        guard case .space(let id)? = origin, id == shownSpaceId, case .counting = card.state else {
            checkIns?.cancel()
            checkIns = nil
            return
        }
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

    private func checkIn() async {
        guard case .space(let id)? = origin, id == shownSpaceId, let beat = current else { return }
        let gen = generation
        let r = await api.checkIn(beat.beatId, spaceId: id)
        guard gen == generation else { return }
        switch r {
        case .ok(let updated):
            show(updated)
            await remind(updated, atMs: wallClock())
        case .error(let e):
            // A phone that dropped offline for a moment just checks in at the next tick; any other failure is shown and ends the loop
            guard e.code != "offline" else { return }
            card.apply(error: e)
            checkIns?.cancel()
            checkIns = nil
        }
    }

    /// At a BEAT's first check-in: asks to send notifications and sets the reminder for `atMs` plus the minimum minutes.
    private func remind(_ beat: AppBeatCard, atMs: Int64) async {
        guard beat.minMinutes > 0, !reminded.contains(beat.beatId) else { return }
        reminded.insert(beat.beatId)
        await notifier.requestPermission()
        notifier.schedule(beatId: beat.beatId, name: beat.name, atMs: atMs + Int64(beat.minMinutes) * 60_000)
    }
}
