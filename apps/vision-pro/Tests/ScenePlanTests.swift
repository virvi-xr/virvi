import XCTest

final class ScenePlanTests: XCTestCase {
    func testImagesVideosModelsAndSkips() throws {
        let json = """
        {"images":[{"sk":"img","textureSrc":"https://x/a.PNG?x=1","instances":[
            {"sk":"i1","position":{"x":1,"y":2,"z":3},"scale":{"x":4,"y":2,"z":1}},
            {"sk":"i2","enabled":false}]},
          {"sk":"gif","textureSrc":"https://x/a.gif","instances":[{"sk":"g"}]}],
         "videos":[{"sk":"vid","offType":1,"offImageSrc":"https://x/off.jpg","instances":[{"sk":"v1"}]},
                   {"sk":"pl","offType":2,"playlist":["https://x/p.mp4"],"volume":0.5,"instances":[{"sk":"p1"}]}],
         "models":[{"sk":"m","modelSrc":"https://x/m.glb","enabled":true,"instances":[{"sk":"m1"}]},
                   {"sk":"off","modelSrc":"https://x/o.glb","enabled":false,"instances":[{"sk":"o1"}]}],
         "sounds":[]}
        """
        let scene = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props)
        let items = planScene(scene)
        XCTAssertEqual(items.map(\.key), ["vid:v1", "pl:p1", "img:i1", "m:m1"])
        XCTAssertEqual(items[0].kind, .image)
        XCTAssertEqual(items[0].volume, 0)
        XCTAssertEqual(items[1].kind, .video)
        XCTAssertEqual(items[1].volume, 0.5)
        XCTAssertEqual(items[2].width, 4)
        XCTAssertEqual(items[2].height, 2)
        XCTAssertEqual(items[2].transform.position, [1, 2, -3])
        XCTAssertEqual(items[3].kind, .model)
    }

    func testItemsCarryTheirVirviTransformAndElementType() throws {
        let json = """
        {"videos":[{"sk":"vid","offType":1,"offImageSrc":"https://x/off.jpg","instances":[
            {"sk":"v1","position":{"x":1,"y":2,"z":3},"rotation":{"x":0,"y":30,"z":0},"scale":{"x":4,"y":2,"z":1}}]}],
         "models":[{"sk":"m","modelSrc":"https://x/m.glb","instances":[{"sk":"m1"}]}],
         "sounds":[{"sk":"s","audioSrc":"https://x/a.mp3","instances":[{"sk":"s1"}]}]}
        """
        let scene = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props)
        let items = planScene(scene)
        XCTAssertEqual(items[0].kind, .image) // a video showing its off image still drafts as a video
        XCTAssertEqual(items[0].elementKind, "video")
        XCTAssertEqual(items[0].source, ItemTransform(position: [1, 2, 3], rotation: [0, 30, 0], scale: [4, 2, 1]))
        XCTAssertEqual(items[1].elementKind, "model")
        XCTAssertEqual(items[1].source, ItemTransform(position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1]))
        XCTAssertEqual(items[2].elementKind, "sound")
    }

    func testPlaylistModeCarriesThePlaylist() throws {
        func video(_ playlist: String) throws -> RenderItem? {
            let json = """
            {"videos":[{"sk":"pl","offType":2,"playlist":\(playlist),"instances":[{"sk":"p1"}]}]}
            """
            return planScene(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? Props)).first
        }
        let three = try XCTUnwrap(video(#"["https://x/1.mp4","https://x/2.webm","https://x/3.m3u8","https://x/4.mp4"]"#))
        XCTAssertEqual(three.src, "https://x/1.mp4")
        XCTAssertEqual(three.playlist, ["https://x/1.mp4", "https://x/3.m3u8", "https://x/4.mp4"])
        XCTAssertFalse(three.loop)
        let one = try XCTUnwrap(video(#"["https://x/a.webm","https://x/1.mp4"]"#))
        XCTAssertEqual(one.playlist, ["https://x/1.mp4"])
        XCTAssertTrue(one.loop)
        XCTAssertNil(try video("[]"))
        let live = planScene(["videos": [["sk": "l", "isLive": true, "enableLiveStream": true, "liveSrc": "https://x/s.m3u8",
                                          "instances": [["sk": "1"]]]]])
        XCTAssertEqual(live.first?.playlist, [])
    }

    func testDiff() {
        let a = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "1"], ["sk": "2"]]]]])
        let b = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "2", "scale": ["x": 2]], ["sk": "3"]]]]])
        let d = diffPlans(a, b)
        XCTAssertEqual(d.remove, ["e:1"])
        XCTAssertEqual(d.update.map(\.key), ["e:2"])
        XCTAssertEqual(d.add.map(\.key), ["e:3"])
    }
}
