import XCTest

/// Scheduled showings (LIV-87): the same moment for everyone, as packages/shared src/showings.ts works it out.
final class ShowingsTests: XCTestCase {
    let t0: Int64 = 1_800_000_000_000
    let trailer = ProgrammeItem(url: "https://x/trailer.mp4", duration: 60, kind: "ad")
    let film = ProgrammeItem(url: "https://x/film.mp4", duration: 5400, kind: "video")
    func show(_ start: Int64? = nil, id: String = "s1", items: [ProgrammeItem]? = nil) -> ShowingInstance {
        ShowingInstance(showingId: id, startsAt: start ?? t0, items: items ?? [trailer, film], title: "Film")
    }

    func testBetweenShowingsItCountsDownToTheNext() {
        guard case let .between(next, startsIn) = screenStateAt([show()], now: t0 - 1000) else { return XCTFail() }
        XCTAssertEqual(next?.showingId, "s1")
        XCTAssertEqual(startsIn ?? -1, 1, accuracy: 1e-9)
        guard case .between(nil, nil) = screenStateAt([], now: t0) else { return XCTFail() }
    }

    func testMidFilmItIsTheFilmAndHowFarIn() {
        guard case let .playing(_, _, index, offset, itemStartsAt) = screenStateAt([show()], now: t0 + Int64((60 + 754.5) * 1000)) else { return XCTFail() }
        XCTAssertEqual(index, 1)
        XCTAssertEqual(offset, 754.5, accuracy: 1e-6)
        XCTAssertEqual(itemStartsAt, t0 + 60_000)
    }

    func testItemsWithNoLengthAreSkippedAndAfterTheEndItIsBetween() {
        let s = show(items: [ProgrammeItem(url: "https://x/none.mp4", duration: 0, kind: "ad"), film])
        guard case let .playing(_, _, index, _, _) = screenStateAt([s], now: t0 + 1000) else { return XCTFail() }
        XCTAssertEqual(index, 1)
        guard case .between = screenStateAt([s], now: t0 + 5_400_000) else { return XCTFail() }
    }

    func testTheLaterStartWinsWhenShowingsOverlap() {
        guard case let .playing(showing, _, _, _, _) = screenStateAt([show(id: "a"), show(t0 + 10_000, id: "b")], now: t0 + 20_000) else { return XCTFail() }
        XCTAssertEqual(showing.showingId, "b")
    }

    func testParsesTheFeedsShowingsByScreenDroppingMalformedOnes() throws {
        let json = """
        [{"elementId":"tv","showings":[{"showingId":"s1","startsAt":\(t0),"title":"Film",
           "items":[{"url":"https://x/film.mp4","duration":5400,"kind":"video"},{"url":7}]},{"startsAt":"x"}]},
         {"showings":[]}]
        """
        let m = parseShowings(try JSONSerialization.jsonObject(with: Data(json.utf8)))
        XCTAssertEqual(Set(m.keys), ["tv"])
        XCTAssertEqual(m["tv"], [ShowingInstance(showingId: "s1", startsAt: t0, items: [film], title: "Film")])
        XCTAssertTrue(parseShowings(nil).isEmpty)
    }

    func scheduled(_ holding: String? = "https://x/poster.png") throws -> [RenderItem] {
        let off = holding.map { ",\"offImageSrc\":\"\($0)\"" } ?? ""
        let json = "{\"videos\":[{\"sk\":\"tv\",\"offType\":6\(off),\"volume\":0.7,\"instances\":[{\"sk\":\"i1\"}]}]}"
        return planScene(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props))
    }

    func testScheduleModePlansAScheduledScreenWithItsHoldingImage() throws {
        let item = try XCTUnwrap(try scheduled().first)
        XCTAssertTrue(item.scheduled)
        XCTAssertEqual(item.holdingImage, "https://x/poster.png")
        XCTAssertEqual(item.elementKind, "video")
    }

    func testAScheduledScreenShowsTheHoldingImageThenEachVideoFromWhereTheShowIs() throws {
        let base = try scheduled()
        let shows = ["tv": [show()]]
        let before = try XCTUnwrap(resolveScheduled(base, shows, now: t0 - 1000).first)
        XCTAssertEqual(before.kind, .image)
        XCTAssertEqual(before.src, "https://x/poster.png")
        XCTAssertNil(before.play)

        let inTrailer = try XCTUnwrap(resolveScheduled(base, shows, now: t0 + 10_000).first)
        XCTAssertEqual(inTrailer.kind, .video)
        XCTAssertEqual(inTrailer.src, "https://x/trailer.mp4")
        XCTAssertFalse(inTrailer.loop)
        XCTAssertEqual(inTrailer.play, ScheduledPlay(itemStartsAtMs: t0, durationS: 60))
        // The plan stays the same while the same video plays, so the renderer leaves it alone
        XCTAssertEqual(resolveScheduled(base, shows, now: t0 + 20_000), [inTrailer])

        let inFilm = try XCTUnwrap(resolveScheduled(base, shows, now: t0 + 61_000).first)
        XCTAssertEqual(inFilm.play, ScheduledPlay(itemStartsAtMs: t0 + 60_000, durationS: 5400))
    }

    func testWithNoHoldingImageNothingShowsBetweenAndAVideoTheHeadsetCannotPlayCountsAsBetween() throws {
        XCTAssertTrue(resolveScheduled(try scheduled(nil), ["tv": [show()]], now: t0 - 1000).isEmpty)
        let mov = ["tv": [show(items: [ProgrammeItem(url: "https://x/film.mov", duration: 600, kind: "video")])]]
        XCTAssertEqual(resolveScheduled(try scheduled(), mov, now: t0 + 1000).first?.kind, .image)
    }

    func testOtherItemsPassThroughUntouched() throws {
        let json = "{\"images\":[{\"sk\":\"img\",\"textureSrc\":\"https://x/a.png\",\"instances\":[{\"sk\":\"i\"}]}]}"
        let plan = planScene(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props))
        XCTAssertEqual(resolveScheduled(plan, [:], now: t0), plan)
    }

    func testDriftIsCorrectedWithDecentralandsGuards() {
        let g = SeekGuard(startedAt: 0)
        XCTAssertFalse(g.shouldSeek(now: 10_000, expected: 10, actual: 0, duration: 600, playing: true)) // settling
        XCTAssertFalse(g.shouldSeek(now: 31_000, expected: 31, actual: 30, duration: 600, playing: true)) // within 2 s
        XCTAssertFalse(g.shouldSeek(now: 33_000, expected: 33, actual: 20, duration: 600, playing: true)) // checked under 5 s ago
        XCTAssertTrue(g.shouldSeek(now: 37_000, expected: 37, actual: 20, duration: 600, playing: true))
        XCTAssertFalse(g.shouldSeek(now: 70_000, expected: 70, actual: 20, duration: 600, playing: false)) // paused
        XCTAssertTrue(g.shouldSeek(now: 70_000, expected: 70, actual: 20, duration: 600, playing: true))
        XCTAssertTrue(g.shouldSeek(now: 110_000, expected: 110, actual: 20, duration: 600, playing: true))
        XCTAssertFalse(g.shouldSeek(now: 150_000, expected: 150, actual: 20, duration: 600, playing: true)) // 3 re-seeks used
        XCTAssertFalse(SeekGuard(startedAt: 0).shouldSeek(now: 595_000, expected: 595, actual: 500, duration: 600, playing: true)) // last 10 s
    }
}
