import Foundation

// The wire shapes of packages/shared/src/beats.ts (AppBeatCard) and the state the BEAT card in the app shows.

public struct AppBeatClaim: Equatable, Sendable {
    /// `present`, `waiting`, `claimed`, `minting`, `minted`, `failed` or `removed`.
    public var status: String
    public var secondsPresent: Int
    public var wallet: String?
    public var checkedInAt: String?

    public init(status: String, secondsPresent: Int, wallet: String?, checkedInAt: String?) {
        self.status = status
        self.secondsPresent = secondsPresent
        self.wallet = wallet
        self.checkedInAt = checkedInAt
    }
}

/// A BEAT as the app shows it; `claim` is the caller's own, `wallets` the caller's wallets that can collect BEATs.
public struct AppBeatCard: Equatable, Sendable {
    public var beatId: String
    public var name: String
    public var imageUrl: String
    public var minMinutes: Int
    public var startsAt: String
    public var endsAt: String
    public var locationType: String
    public var venue: String?
    /// The BEAT has a venue pin: checking in from an event ARC and claiming need the phone's location. No pin, no check.
    public var pinned: Bool
    public var claim: AppBeatClaim?
    public var wallets: [String]

    public init(beatId: String, name: String, imageUrl: String, minMinutes: Int, startsAt: String, endsAt: String,
                locationType: String, venue: String? = nil, pinned: Bool = false, claim: AppBeatClaim? = nil, wallets: [String] = []) {
        self.beatId = beatId
        self.name = name
        self.imageUrl = imageUrl
        self.minMinutes = minMinutes
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.locationType = locationType
        self.venue = venue
        self.pinned = pinned
        self.claim = claim
        self.wallets = wallets
    }
}

/// A refusal from an app route: the server's `{error, message}` (and `wallets` with `choose_wallet`). `status` 0 is
/// a request that never got an answer; `code` then is `offline`, `signed_out` or `attest_failed`.
public struct AppBeatError: Error, Equatable, Sendable {
    public var status: Int
    public var code: String
    public var message: String
    public var wallets: [String]

    public init(status: Int, code: String, message: String, wallets: [String] = []) {
        self.status = status
        self.code = code
        self.message = message
        self.wallets = wallets
    }
}

private func jsonString(_ o: [String: Any], _ k: String) -> String? { o[k] as? String }

private func jsonInt(_ o: [String: Any], _ k: String) -> Int? {
    guard let n = o[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
    return Int(n.doubleValue)
}

/// An `AppBeatCard` from its JSON object; nil when a required field is missing or the wrong type.
public func parseAppBeatCard(_ json: Any?) -> AppBeatCard? {
    guard let o = json as? [String: Any], let id = jsonString(o, "beatId"), let name = jsonString(o, "name"),
          let minMinutes = jsonInt(o, "minMinutes"), let location = o["location"] as? [String: Any],
          let type = jsonString(location, "type") else { return nil }
    var claim: AppBeatClaim?
    if let c = o["claim"] as? [String: Any] {
        guard let status = jsonString(c, "status") else { return nil }
        claim = AppBeatClaim(status: status, secondsPresent: jsonInt(c, "secondsPresent") ?? 0,
                             wallet: jsonString(c, "wallet"), checkedInAt: jsonString(c, "checkedInAt"))
    }
    return AppBeatCard(beatId: id, name: name, imageUrl: jsonString(o, "imageUrl") ?? "", minMinutes: minMinutes,
                       startsAt: jsonString(o, "startsAt") ?? "", endsAt: jsonString(o, "endsAt") ?? "",
                       locationType: type, venue: jsonString(location, "venue"), pinned: (o["pinned"] as? Bool) ?? false, claim: claim,
                       wallets: (o["wallets"] as? [String]) ?? [])
}

/// The seconds a tracked BEAT still needs: the minimum less the server's live `secondsPresent` (never below 0); nil when
/// nothing is counting (no claim, or one that is no longer `present`).
public func beatSecondsLeft(_ card: AppBeatCard) -> Int? {
    guard let claim = card.claim, claim.status == "present" else { return nil }
    return max(0, card.minMinutes * 60 - claim.secondsPresent)
}

/// When an in-person claim can be made (UTC ms): the time left counted from `nowMs` (the card's fetch), or from the
/// BEAT's start when it hasn't started, since nothing counts before then. The claim's own check-in time isn't used: a
/// claim started elsewhere keeps that place's. Nil when nothing is counting.
public func beatClaimDueMs(_ card: AppBeatCard, nowMs: Int64) -> Int64? {
    guard let left = beatSecondsLeft(card) else { return nil }
    let from = max(nowMs, beatTimeMs(card.startsAt) ?? nowMs)
    return left == 0 ? nowMs : from + Int64(left) * 1000
}

/// An ISO time from the server, in UTC ms.
func beatTimeMs(_ s: String) -> Int64? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let d = f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    return d.map { Int64($0.timeIntervalSince1970 * 1000) }
}

public enum BeatCardState: Equatable, Sendable {
    case hidden
    case signInToEarn(name: String, minutes: Int)
    case track(name: String, minutes: Int)
    case counting(name: String, minutesLeft: Int)
    case claimable(name: String)
    case chooseWallet(name: String, wallets: [String])
    case claiming
    case waitingForWallet(name: String)
    case sent(name: String)
    case outside(venue: String)
    case poorFix
    case failed(message: String)
}

/// What the BEAT card shows, from the server's card (`apply(_:signedIn:nowMs:)`) and from a refused request
/// (`apply(error:)`). The server's `secondsPresent` is the clock: it is as of the card's fetch, so the card is fetched
/// again to count down.
public struct BeatCard: Sendable {
    public private(set) var state: BeatCardState = .hidden
    private var card: AppBeatCard?

    public init() {}

    public mutating func apply(_ card: AppBeatCard?, signedIn: Bool, nowMs: Int64) {
        self.card = card
        guard let card else { return state = .hidden }
        guard signedIn else { return state = .signInToEarn(name: card.name, minutes: card.minMinutes) }
        guard let claim = card.claim else {
            // No one can start tracking a BEAT that has ended
            if let end = beatTimeMs(card.endsAt), nowMs > end { return state = .hidden }
            return state = .track(name: card.name, minutes: card.minMinutes)
        }
        switch claim.status {
        case "present":
            let left = minutesLeft(card, claim)
            state = left > 0 ? .counting(name: card.name, minutesLeft: left) : .claimable(name: card.name)
        case "waiting": state = .waitingForWallet(name: card.name)
        case "claimed", "minting", "minted": state = .sent(name: card.name)
        case "failed": state = .failed(message: VisitorCopy.BEAT_TRY_AGAIN)
        default: state = .hidden
        }
    }

    /// The claim is on its way to the server: the card shows progress until the answer (a card or an error) replaces it.
    public mutating func beginClaim() { state = .claiming }

    public mutating func apply(error: AppBeatError) {
        let name = card?.name ?? ""
        switch error.code {
        case "choose_wallet": state = .chooseWallet(name: name, wallets: error.wallets)
        case "outside": state = .outside(venue: card?.venue ?? VisitorCopy.THE_VENUE)
        case "poor_fix": state = .poorFix
        case "not_yet":
            if let card, let claim = card.claim { state = .counting(name: name, minutesLeft: max(1, minutesLeft(card, claim))) }
            else { state = .failed(message: error.message) }
        default: state = .failed(message: error.message)
        }
    }

    /// The line the card shows for its state; nil when it shows none.
    public var text: String? {
        switch state {
        case .hidden, .claiming: return nil
        case .signInToEarn(let n, let m), .track(let n, let m): return VisitorCopy.beatAttend(minutes: m, name: n)
        case .counting(let n, let m): return VisitorCopy.beatAttend(minutes: m, name: n)
        case .claimable(let n): return VisitorCopy.beatAttend(minutes: card?.minMinutes ?? 0, name: n)
        case .chooseWallet: return nil
        case .waitingForWallet: return VisitorCopy.BEAT_WAITING
        case .sent(let n): return VisitorCopy.beatSent(name: n)
        // Before a claim exists it is the check-in that was refused
        case .outside(let v): return card?.claim == nil ? VisitorCopy.beatOutsideCheckIn(venue: v) : VisitorCopy.beatOutsideClaim(venue: v)
        case .poorFix: return VisitorCopy.BEAT_POOR_FIX
        case .failed(let m): return m
        }
    }

    /// The card's button, when its state has one.
    public var buttonTitle: String? {
        switch state {
        case .signInToEarn: return VisitorCopy.BEAT_SIGN_IN
        case .track: return VisitorCopy.BEAT_TRACK
        case .claimable, .chooseWallet: return VisitorCopy.BEAT_CLAIM
        default: return nil
        }
    }

    private func minutesLeft(_ card: AppBeatCard, _ claim: AppBeatClaim) -> Int {
        let leftSeconds = card.minMinutes * 60 - claim.secondsPresent
        return leftSeconds <= 0 ? 0 : (leftSeconds + 59) / 60
    }
}
