import Observation
import SwiftUI
import VirviARKit

/// What My BEATs lists: the signed-in account's BEATs (`GET /api/app/beats/mine`), each with how it stands.
@MainActor
@Observable
final class MyBeatsModel {
    static let TITLE = "My BEATs"
    static let EMPTY = "No BEATs yet. Track one at an event or in a space."

    struct Row: Equatable, Identifiable {
        var id: String
        var name: String
        /// The card's line for where this BEAT stands, nil when it has none.
        var status: String?
        /// The BEAT as the server gave it, for its card.
        var card: AppBeatCard
        /// In progress or ready to claim: tapping the row opens its card.
        var opens: Bool
    }

    enum Phase: Equatable {
        case idle
        case loading
        case loaded([Row])
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    @ObservationIgnored private let api: AppBeatApi
    @ObservationIgnored private let wallClock: () -> Int64
    /// Set by the app: puts a BEAT's card up for its page.
    @ObservationIgnored var openCard: (AppBeatCard) -> Void = { _ in }

    init(api: AppBeatApi, wallClock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) {
        self.api = api
        self.wallClock = wallClock
    }

    /// A row was tapped: a BEAT in progress or ready to claim opens its card ("Claim your BEAT" once it can be claimed).
    func open(_ row: Row) {
        guard row.opens else { return }
        openCard(row.card)
    }

    func load() async {
        // A reload keeps the list on screen until the answer comes
        if case .loaded = phase {} else { phase = .loading }
        switch await api.mine() {
        case .ok(let cards):
            phase = .loaded(cards.map { c in
                var card = BeatCard()
                card.apply(c, signedIn: true, nowMs: wallClock())
                let opens: Bool
                switch card.state {
                case .counting, .claimable: opens = true
                default: opens = false
                }
                return Row(id: c.beatId, name: c.name, status: card.text, card: c, opens: opens)
            })
        case .error(let e): phase = .failed(e.message)
        }
    }
}
