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
    /// Set by the app: opens a BEAT's card on the camera view.
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
        phase = .loading
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

struct MyBeatsView: View {
    let model: MyBeatsModel
    let close: () -> Void
    /// A row's card was opened: the sheets make way for the camera view.
    var opened: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(MyBeatsModel.TITLE).font(.title3.weight(.semibold))
            switch model.phase {
            case .idle, .loading: ProgressView().frame(maxWidth: .infinity)
            case .failed(let message): Text(message).foregroundStyle(.secondary)
            case .loaded(let rows):
                if rows.isEmpty { Text(MyBeatsModel.EMPTY).foregroundStyle(.secondary) }
                else {
                    List(rows) { row in
                        let line = VStack(alignment: .leading, spacing: 2) {
                            Text(row.name).font(.headline)
                            if let s = row.status { Text(s).font(.subheadline).foregroundStyle(.secondary) }
                        }
                        if row.opens {
                            Button { model.open(row); opened() } label: { line }.buttonStyle(.plain)
                        } else {
                            line
                        }
                    }
                    .listStyle(.plain)
                }
            }
            Button(action: close) { Text(VisitorCopy.CLOSE).frame(maxWidth: .infinity) }
                .buttonStyle(.bordered).controlSize(.large)
        }
        .padding(16)
        .task { await model.load() }
    }
}
