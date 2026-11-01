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

    func testDiff() {
        let a = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "1"], ["sk": "2"]]]]])
        let b = planScene(["images": [["sk": "e", "textureSrc": "https://x/a.png", "instances": [["sk": "2", "scale": ["x": 2]], ["sk": "3"]]]]])
        let d = diffPlans(a, b)
        XCTAssertEqual(d.remove, ["e:1"])
        XCTAssertEqual(d.update.map(\.key), ["e:2"])
        XCTAssertEqual(d.add.map(\.key), ["e:3"])
    }
}
