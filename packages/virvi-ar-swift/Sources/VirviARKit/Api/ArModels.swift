import Foundation

// The wire shapes of packages/shared/src/ar.ts (ArFeedResponse, ArMarkerLookup), as the Quest's ArModels.kt.

public struct MarkerPose: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double
    public var headingDeg: Double

    public init(x: Double, y: Double, z: Double, headingDeg: Double) {
        self.x = x
        self.y = y
        self.z = z
        self.headingDeg = headingDeg
    }
}

public struct ArMarker: Equatable, Sendable {
    public var id: String
    public var ringId: UInt32
    public var code: String
    public var diameterMm: Double
    public var whereText: String?
    public var pose: MarkerPose?

    public init(id: String, ringId: UInt32, code: String, diameterMm: Double, whereText: String? = nil, pose: MarkerPose? = nil) {
        self.id = id
        self.ringId = ringId
        self.code = code
        self.diameterMm = diameterMm
        self.whereText = whereText
        self.pose = pose
    }
}

public struct ArFloor: Equatable, Sendable {
    public var id: String
    public var name: String
    public var heightM: Double
    public var sortOrder: Int
    public var markers: [ArMarker]

    public init(id: String, name: String, heightM: Double, sortOrder: Int, markers: [ArMarker]) {
        self.id = id
        self.name = name
        self.heightM = heightM
        self.sortOrder = sortOrder
        self.markers = markers
    }
}

public struct ArSpace: Equatable, Sendable {
    public var id: String
    public var name: String
    public var place: String?
    public var published: Bool
    public var floors: [ArFloor]

    public init(id: String, name: String, place: String? = nil, published: Bool, floors: [ArFloor]) {
        self.id = id
        self.name = name
        self.place = place
        self.published = published
        self.floors = floors
    }

    public func markerByRing(_ ringId: UInt32) -> (ArFloor, ArMarker)? {
        for f in floors { for m in f.markers where m.ringId == ringId { return (f, m) } }
        return nil
    }
}

public struct MarkerLookup: Equatable, Sendable {
    public var spaceId: String
    public var floorId: String
    public var markerId: String
    public var spaceName: String
    public var whereText: String?

    public init(spaceId: String, floorId: String, markerId: String, spaceName: String, whereText: String? = nil) {
        self.spaceId = spaceId
        self.floorId = floorId
        self.markerId = markerId
        self.spaceName = spaceName
        self.whereText = whereText
    }
}

/// `version` is opaque; `scene` is the feed's serialized scene, exactly what `planScene(_:)` takes (nil when the space
/// has none). `showings` are the scheduled screens' shows by element id, and `serverTime` the server's clock when it
/// answered (UTC ms). Immutable parsed JSON, so it is safe to hand across threads.
public struct ArFeedSnapshot: @unchecked Sendable {
    public var version: String
    public var space: ArSpace
    public var scene: Props?
    public var showings: [String: [ShowingInstance]]
    public var serverTime: Int64?

    public init(version: String, space: ArSpace, scene: Props? = nil, showings: [String: [ShowingInstance]] = [:], serverTime: Int64? = nil) {
        self.version = version
        self.space = space
        self.scene = scene
        self.showings = showings
        self.serverTime = serverTime
    }
}

// MARK: parsing

private func str(_ o: Props, _ k: String) -> String? { o[k] as? String }

/// A JSON number (not a boolean), finite.
private func num(_ o: Props, _ k: String) -> Double? {
    guard let n = o[k] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
    return n.doubleValue
}

/// A JSON number with no fraction that fits `Int64`.
private func integer(_ o: Props, _ k: String) -> Int64? {
    guard let d = num(o, k), d == d.rounded(), abs(d) < 9.0e18, let n = o[k] as? NSNumber else { return nil }
    return n.int64Value
}

private func parsePose(_ e: Any?) -> MarkerPose? {
    guard let o = e as? Props, let x = num(o, "x"), let y = num(o, "y"), let z = num(o, "z"), let h = num(o, "headingDeg") else { return nil }
    return MarkerPose(x: x, y: y, z: z, headingDeg: h)
}

private func parseMarker(_ e: Any) -> ArMarker? {
    guard let o = e as? Props, let id = str(o, "id"), let ring = integer(o, "ringId"), ring >= 0, ring <= Int64(UInt32.max),
          let code = str(o, "code"), let d = num(o, "diameterMm") else { return nil }
    return ArMarker(id: id, ringId: UInt32(ring), code: code, diameterMm: d, whereText: str(o, "whereText"), pose: parsePose(o["pose"]))
}

private func parseFloor(_ e: Any) -> ArFloor? {
    guard let o = e as? Props, let raw = o["markers"] as? [Any] else { return nil }
    var markers: [ArMarker] = []
    for m in raw {
        guard let marker = parseMarker(m) else { return nil }
        markers.append(marker)
    }
    guard let id = str(o, "id"), let name = str(o, "name"), let h = num(o, "heightM"), let order = integer(o, "sortOrder"),
          let sort = Int(exactly: order) else { return nil }
    return ArFloor(id: id, name: name, heightM: h, sortOrder: sort, markers: markers)
}

private func parseSpace(_ e: Any?) -> ArSpace? {
    guard let o = e as? Props, let raw = o["floors"] as? [Any] else { return nil }
    var floors: [ArFloor] = []
    for f in raw {
        guard let floor = parseFloor(f) else { return nil }
        floors.append(floor)
    }
    guard let id = str(o, "id"), let name = str(o, "name") else { return nil }
    let published = (o["published"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
    return ArSpace(id: id, name: name, place: str(o, "place"), published: published, floors: floors)
}

private func parseObject(_ data: Data) -> Props? {
    (try? JSONSerialization.jsonObject(with: data)) as? Props
}

/// `{ v: 1, version, space, scene }`; nil for any other version or a malformed body.
public func parseFeed(_ data: Data) -> ArFeedSnapshot? {
    guard let o = parseObject(data), integer(o, "v") == 1, let version = str(o, "version"), let space = parseSpace(o["space"]) else { return nil }
    return ArFeedSnapshot(version: version, space: space, scene: o["scene"] as? Props, showings: parseShowings(o["showings"]), serverTime: integer(o, "serverTime"))
}

public func parseLookup(_ data: Data) -> MarkerLookup? {
    guard let o = parseObject(data), let s = str(o, "spaceId"), let f = str(o, "floorId"), let m = str(o, "markerId"),
          let n = str(o, "spaceName") else { return nil }
    return MarkerLookup(spaceId: s, floorId: f, markerId: m, spaceName: n, whereText: str(o, "whereText"))
}
