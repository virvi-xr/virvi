import Foundation
import XCTest
@testable import VirviARKit

final class RingCodecTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        // .../packages/virvi-ar-swift/Tests/VirviARKitTests/Ring/RingCodecTests.swift -> repo root
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        url.appendPathComponent("apps/ring-marker/vectors/codec.json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func int(_ v: Any?) -> Int { (v as? NSNumber)?.intValue ?? -1 }

    func testVectorsMatch() throws {
        let root = try vectors()
        let encodes = try XCTUnwrap(root["encode"] as? [[String: Any]])
        let decodes = try XCTUnwrap(root["decode"] as? [[String: Any]])
        XCTAssertEqual(encodes.count, 12)
        XCTAssertEqual(decodes.count, 15)

        for o in encodes {
            let id = UInt32(int(o["id"]))
            let version = int(o["version"])
            let want = (o["cells"] as! String).map { $0 == "1" }
            XCTAssertEqual(RingCodec.encode(id: id, version: version), want, "encode \(id) v\(version)")
        }

        for o in decodes {
            let rule = o["rule"] as! String
            let cells: [Bool?] = (o["cells"] as! String).map { $0 == "?" ? nil : $0 == "1" }
            var want: RingDecoded?
            if let e = o["expect"] as? [String: Any] {
                want = RingDecoded(id: UInt32(int(e["id"])), version: int(e["version"]), corrected: int(e["corrected"]))
            }
            XCTAssertEqual(RingCodec.decode(cells), want, "decode: \(rule)")
        }
    }

    func testCodeOfIsCrockfordBase32() {
        XCTAssertEqual(RingCodec.codeOf(0), "0000000")
        XCTAssertEqual(RingCodec.codeOf(0xFFFF_FFFF), "3ZZZZZZ")
    }

    func testTestMarkersRoundTripThroughCodes() {
        XCTAssertEqual(RING_TEST_MARKERS.map { $0.name }, ["RING120", "RING140", "RING170"])
        XCTAssertEqual(RING_TEST_MARKERS.map { $0.id }, [0x1D2C3B4A, 0x2E3D4C5B, 0x3F4E5D6C])
        XCTAssertEqual(RING_TEST_MARKERS.map { $0.diameterM }, [0.120, 0.140, 0.170])
        for m in RING_TEST_MARKERS {
            XCTAssertEqual(RingCodec.parseCode(RingCodec.codeOf(m.id)), m.id, m.name)
        }
    }

    func testParseCodeNormalisesAndRefuses() {
        XCTAssertEqual(RingCodec.parseCode("o1l-0 00-0"), 0x210_0000)
        XCTAssertEqual(RingCodec.parseCode("0000001"), 1)
        XCTAssertEqual(RingCodec.parseCode("3zzzzzz"), 0xFFFF_FFFF)
        XCTAssertNil(RingCodec.parseCode("4000000")) // 2^32
        XCTAssertNil(RingCodec.parseCode("ZZZZZZZ"))
        XCTAssertNil(RingCodec.parseCode("000000U"))
        XCTAssertNil(RingCodec.parseCode("000000"))
    }
}
