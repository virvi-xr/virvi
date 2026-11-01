import Foundation

/// Port of packages/hyperfy-app/src/plan.ts: which nodes to show for a Virvi scene snapshot.
/// The scene is untyped JSON (from JSONSerialization), so the JS `typeof` checks are mirrored by hand.
struct RenderItem: Equatable {
    enum Kind: String { case video, image, model, audio }

    /// "\(elementSk):\(instanceSk)"
    var key: String
    /// The element's name in Virvi, or the media file name when it has none.
    var name: String
    var kind: Kind
    /// For video, image and model, the URL to show; for audio, the sound.
    var src: String
    var loop: Bool
    var volume: Double
    var width: Double
    var height: Double
    var transform: MappedTransform
    var clickUrl: String?
}

typealias Props = [String: Any]

private let VIDEO_EXT = ["mp4", "m3u8"]
private let IMAGE_EXT = ["png", "jpg", "jpeg", "webp"]
private let CLICK_NONE = 0.0
private let CLICK_EXTERNAL = 1.0
private let OFF_IMAGE = 1.0
private let OFF_PLAYLIST = 2.0

// MARK: - JS-ish value helpers

private func isBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
}

/// `typeof v === 'number' && Number.isFinite(v)`
private func number(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, !isBool(n) else { return nil }
    let d = n.doubleValue
    return d.isFinite ? d : nil
}

/// `v === false`
private func isFalse(_ v: Any?) -> Bool { isBool(v) && (v as! NSNumber).boolValue == false }

/// JS truthiness.
private func truthy(_ v: Any?) -> Bool {
    guard let v, !(v is NSNull) else { return false }
    if isBool(v) { return (v as! NSNumber).boolValue }
    if let d = number(v) { return d != 0 }
    if let n = v as? NSNumber { return !n.doubleValue.isNaN }
    if let s = v as? String { return !s.isEmpty }
    return true
}

private func nonEmptyString(_ v: Any?) -> String? {
    guard let s = v as? String, !s.isEmpty else { return nil }
    return s
}

/// What a JS template literal prints for an `sk`.
private func templateString(_ v: Any?) -> String {
    if let s = v as? String { return s }
    if let d = number(v) { return d == d.rounded() && abs(d) < 1e15 ? String(Int64(d)) : String(d) }
    if v == nil { return "undefined" }
    if v is NSNull { return "null" }
    return String(describing: v!)
}

/// Extension of the URL's path, lowercased; "" when there is none.
func extOf(_ src: String) -> String {
    let path = src.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
    guard let dot = path.lastIndex(of: ".") else { return "" }
    let ext = path[path.index(after: dot)...]
    guard !ext.isEmpty, ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return "" }
    return ext.lowercased()
}

private func supported(_ src: Any?, _ exts: [String]) -> String? {
    guard let s = nonEmptyString(src), exts.contains(extOf(s)) else { return nil }
    return s
}

private func vec(_ v: Any?, _ fallback: Double) -> Vec3 {
    let o = v as? Props ?? [:]
    return Vec3(x: number(o["x"]) ?? fallback, y: number(o["y"]) ?? fallback, z: number(o["z"]) ?? fallback)
}

private func externalUrl(_ click: Any?) -> String? {
    guard let c = click as? Props else { return nil }
    guard number(c["type"]) == CLICK_EXTERNAL else { return nil }
    return nonEmptyString(c["externalLink"])
}

/// An instance's click applies only when it has a type other than NONE; otherwise the element's does.
private func clickOf(_ inst: Props, _ el: Props) -> Any? {
    if let own = inst["clickEvent"] as? Props, let t = number(own["type"]), t != CLICK_NONE { return own }
    return el["clickEvent"]
}

private typealias Media = (kind: RenderItem.Kind, src: String, loop: Bool)

private func videoMedia(_ el: Props) -> Media? {
    if truthy(el["isLive"]) && truthy(el["enableLiveStream"]), let live = nonEmptyString(el["liveSrc"]) {
        return supported(live, VIDEO_EXT).map { (.video, $0, true) }
    }
    if number(el["offType"]) == OFF_PLAYLIST {
        let first = (el["playlist"] as? [Any])?.first
        return supported(first, VIDEO_EXT).map { (.video, $0, true) }
    }
    if number(el["offType"]) == OFF_IMAGE {
        return supported(el["offImageSrc"], IMAGE_EXT).map { (.image, $0, false) }
    }
    return nil
}

private func elementMedia(_ kind: RenderItem.Kind, _ el: Props) -> Media? {
    switch kind {
    case .video: return videoMedia(el)
    case .image: return supported(el["textureSrc"], IMAGE_EXT).map { (.image, $0, false) }
    case .model: return nonEmptyString(el["modelSrc"]).map { (.model, $0, false) }
    case .audio: return nonEmptyString(el["audioSrc"]).map { (.audio, $0, true) }
    }
}

private func planElements(_ out: inout [RenderItem], _ elements: Any?, _ kind: RenderItem.Kind) {
    for case let el as Props in (elements as? [Any]) ?? [] {
        if isFalse(el["enabled"]) { continue }
        guard let media = elementMedia(kind, el) else { continue }
        let volume = kind == .video || kind == .audio ? (number(el["volume"]) ?? 1) : 0
        for case let inst as Props in (el["instances"] as? [Any]) ?? [] {
            if isFalse(inst["enabled"]) { continue }
            let scale = vec(inst["scale"], 1)
            out.append(RenderItem(
                key: "\(templateString(el["sk"])):\(templateString(inst["sk"]))",
                name: nonEmptyString(el["name"]) ?? (URL(string: media.src)?.lastPathComponent ?? media.src),
                kind: media.kind,
                src: media.src,
                loop: media.loop,
                volume: media.kind == .image ? 0 : volume,
                width: scale.x,
                height: scale.y,
                transform: toRealityKitTransform(position: vec(inst["position"], 0), rotation: vec(inst["rotation"], 0), scale: scale),
                clickUrl: externalUrl(clickOf(inst, el))
            ))
        }
    }
}

/// The nodes to show for a scene snapshot (`scene` is the feed's `scene` object, nil for null).
func planScene(_ scene: Props?) -> [RenderItem] {
    var out: [RenderItem] = []
    guard let scene else { return out }
    planElements(&out, scene["videos"], .video)
    planElements(&out, scene["images"], .image)
    planElements(&out, scene["models"], .model)
    planElements(&out, scene["sounds"], .audio)
    return out
}

struct PlanDiff {
    var add: [RenderItem] = []
    var remove: [String] = []
    var update: [RenderItem] = []
}

func diffPlans(_ prev: [RenderItem], _ next: [RenderItem]) -> PlanDiff {
    var before: [String: RenderItem] = [:]
    for item in prev { before[item.key] = item }
    let nextKeys = Set(next.map(\.key))
    var d = PlanDiff()
    for item in next {
        if let old = before[item.key] {
            if old != item { d.update.append(item) }
        } else {
            d.add.append(item)
        }
    }
    d.remove = prev.filter { !nextKeys.contains($0.key) }.map(\.key)
    return d
}
