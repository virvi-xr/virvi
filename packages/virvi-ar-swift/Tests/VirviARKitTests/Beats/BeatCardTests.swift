@testable import VirviARKit
import XCTest

final class BeatCardTests: XCTestCase {
    private func card(claim: AppBeatClaim? = nil, minMinutes: Int = 5, venue: String? = "The Loft", wallets: [String] = []) -> AppBeatCard {
        AppBeatCard(beatId: "b1", name: "Opening Night", imageUrl: "https://x/i.png", minMinutes: minMinutes,
                    startsAt: "2026-11-24T10:00:00.000Z", endsAt: "2026-11-24T20:00:00.000Z",
                    locationType: "in_person", venue: venue, claim: claim, wallets: wallets)
    }

    private func claim(_ status: String, seconds: Int = 0, wallet: String? = nil) -> AppBeatClaim {
        AppBeatClaim(status: status, secondsPresent: seconds, wallet: wallet, checkedInAt: "2026-11-24T10:00:00.000Z")
    }

    private let now: Int64 = 1_795_532_400_000 // 2026-11-24T15:00Z, inside the window

    private func state(_ c: AppBeatCard?, signedIn: Bool = true) -> BeatCardState {
        var b = BeatCard()
        b.apply(c, signedIn: signedIn, nowMs: now)
        return b.state
    }

    func testNoCardIsHidden() { XCTAssertEqual(state(nil), .hidden) }

    func testSignedOutAsksToSignIn() {
        XCTAssertEqual(state(card(), signedIn: false), .signInToEarn(name: "Opening Night", minutes: 5))
    }

    func testNoClaimOffersToTrack() {
        XCTAssertEqual(state(card()), .track(name: "Opening Night", minutes: 5))
    }

    func testThreeOfFiveMinutesCountsTwoLeft() {
        XCTAssertEqual(state(card(claim: claim("present", seconds: 180))), .counting(name: "Opening Night", minutesLeft: 2))
    }

    func testAPartMinuteRoundsUp() {
        XCTAssertEqual(state(card(claim: claim("present", seconds: 181))), .counting(name: "Opening Night", minutesLeft: 2))
        XCTAssertEqual(state(card(claim: claim("present", seconds: 0))), .counting(name: "Opening Night", minutesLeft: 5))
    }

    func testFiveOfFiveIsClaimable() {
        XCTAssertEqual(state(card(claim: claim("present", seconds: 300))), .claimable(name: "Opening Night"))
        XCTAssertEqual(state(card(claim: claim("present", seconds: 900))), .claimable(name: "Opening Night"))
    }

    func testWaitingForAWallet() {
        XCTAssertEqual(state(card(claim: claim("waiting", seconds: 300))), .waitingForWallet(name: "Opening Night"))
    }

    func testClaimedMintingAndMintedAreSent() {
        for s in ["claimed", "minting", "minted"] {
            XCTAssertEqual(state(card(claim: claim(s, seconds: 300, wallet: "0xA"))), .sent(name: "Opening Night"), s)
        }
    }

    func testRemovedIsHiddenAndAnEndedBeatYouNeverTrackedIsHidden() {
        XCTAssertEqual(state(card(claim: claim("removed"))), .hidden)
        var b = BeatCard()
        b.apply(card(), signedIn: true, nowMs: 1_795_564_800_000) // after endsAt
        XCTAssertEqual(b.state, .hidden)
    }

    func testChooseWalletKeepsTheList() {
        var b = BeatCard()
        b.apply(card(claim: claim("present", seconds: 300)), signedIn: true, nowMs: now)
        b.apply(error: AppBeatError(status: 409, code: "choose_wallet", message: "Choose the wallet to send this BEAT to.", wallets: ["0xA", "0xB"]))
        XCTAssertEqual(b.state, .chooseWallet(name: "Opening Night", wallets: ["0xA", "0xB"]))
    }

    func testOutsideNamesTheVenueAndSaysItInTheRightWords() {
        var b = BeatCard()
        b.apply(card(claim: claim("present", seconds: 300)), signedIn: true, nowMs: now)
        b.apply(error: AppBeatError(status: 403, code: "outside", message: "x"))
        XCTAssertEqual(b.state, .outside(venue: "The Loft"))
        XCTAssertEqual(b.text, "Come back to The Loft to claim this BEAT.")

        var c = BeatCard()
        c.apply(card(), signedIn: true, nowMs: now)
        c.apply(error: AppBeatError(status: 403, code: "outside", message: "x"))
        XCTAssertEqual(c.text, "You need to be at The Loft to check in.")
    }

    func testOutsideWithoutAVenueSaysTheVenue() {
        var b = BeatCard()
        b.apply(card(venue: nil), signedIn: true, nowMs: now)
        b.apply(error: AppBeatError(status: 403, code: "outside", message: "x"))
        XCTAssertEqual(b.state, .outside(venue: "the venue"))
    }

    func testPoorFix() {
        var b = BeatCard()
        b.apply(card(), signedIn: true, nowMs: now)
        b.apply(error: AppBeatError(status: 422, code: "poor_fix", message: "x"))
        XCTAssertEqual(b.state, .poorFix)
        XCTAssertEqual(b.text, "Couldn't get your location accurately. Step outside or near a window and try again.")
    }

    func testNotYetGoesBackToCounting() {
        var b = BeatCard()
        b.apply(card(claim: claim("present", seconds: 240)), signedIn: true, nowMs: now)
        b.apply(error: AppBeatError(status: 409, code: "not_yet", message: "x"))
        XCTAssertEqual(b.state, .counting(name: "Opening Night", minutesLeft: 1))
    }

    func testOtherErrorsShowTheServersWords() {
        for code in ["this_device", "verify_first", "all_claimed", "too_late"] {
            var b = BeatCard()
            b.apply(card(), signedIn: true, nowMs: now)
            b.apply(error: AppBeatError(status: 409, code: code, message: "server said \(code)"))
            XCTAssertEqual(b.state, .failed(message: "server said \(code)"), code)
        }
    }

    func testClaimingThenTheCardReplacesIt() {
        var b = BeatCard()
        b.apply(card(claim: claim("present", seconds: 300)), signedIn: true, nowMs: now)
        b.beginClaim()
        XCTAssertEqual(b.state, .claiming)
        b.apply(card(claim: claim("claimed", seconds: 300, wallet: "0xA")), signedIn: true, nowMs: now)
        XCTAssertEqual(b.state, .sent(name: "Opening Night"))
    }

    func testTheWordsOfEachState() {
        var b = BeatCard()
        b.apply(card(), signedIn: false, nowMs: now)
        XCTAssertEqual(b.text, "Attend for 5 minutes to earn the Opening Night BEAT.")
        XCTAssertEqual(b.buttonTitle, "Sign in to earn this BEAT")
        b.apply(card(), signedIn: true, nowMs: now)
        XCTAssertEqual(b.buttonTitle, "Track my attendance")
        b.apply(card(claim: claim("present", seconds: 300)), signedIn: true, nowMs: now)
        XCTAssertEqual(b.buttonTitle, "Claim your BEAT")
        b.apply(card(claim: claim("waiting", seconds: 300)), signedIn: true, nowMs: now)
        XCTAssertEqual(b.text, "Saved for you. Link a wallet at virvi.io and it'll be sent.")
        b.apply(card(claim: claim("claimed", seconds: 300, wallet: "0xA")), signedIn: true, nowMs: now)
        XCTAssertEqual(b.text, "Your Opening Night BEAT is in your wallet")
    }

    func testParsesTheServersCard() throws {
        let json: [String: Any] = [
            "beatId": "b1", "name": "Opening Night", "imageUrl": "https://x/i.png", "minMinutes": 5,
            "startsAt": "2026-11-24T10:00:00.000Z", "endsAt": "2026-11-24T20:00:00.000Z",
            "location": ["type": "in_person", "venue": "The Loft"],
            "claim": ["status": "present", "secondsPresent": 180, "wallet": NSNull(), "checkedInAt": "2026-11-24T10:00:00.000Z"],
            "wallets": ["0xA"],
        ]
        let parsed = parseAppBeatCard(json)
        XCTAssertEqual(parsed, card(claim: claim("present", seconds: 180), wallets: ["0xA"]))
        XCTAssertNil(parseAppBeatCard(["beatId": "b1"]))
    }
}
