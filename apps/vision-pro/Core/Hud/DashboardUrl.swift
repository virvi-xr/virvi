import Foundation

/// Port of packages/core/src/dashboard-url.ts: the website origin for an API URL, or nil when it can't be derived
/// (userinfo, IPv6, garbage).
func dashboardOriginFor(apiUrl: String) -> String? {
    let s = apiUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    let re = try! NSRegularExpression(pattern: #"^(https?:)//([^/:?#@\[\]]+)(?::(\d+))?(?:[/?#]|$)"#, options: [.caseInsensitive])
    guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
    func group(_ i: Int) -> String? { Range(m.range(at: i), in: s).map { String(s[$0]) } }
    let proto = group(1)!.lowercased()
    let hostname = group(2)!.lowercased()
    let rawPort = group(3)
    let isDefaultPort = (proto == "https:" && rawPort == "443") || (proto == "http:" && rawPort == "80")
    let port = rawPort.map { isDefaultPort ? "" : ":\($0)" } ?? ""
    if hostname == "localhost" || hostname == "127.0.0.1" { return "http://localhost:3000" }
    if hostname.hasPrefix("api.") { return "\(proto)//\(hostname.dropFirst(4))\(port)" }
    if let r = hostname.range(of: "-api.") { return "\(proto)//\(hostname.replacingCharacters(in: r, with: "."))\(port)" }
    return "\(proto)//\(hostname)\(port)"
}

func dashboardUrlFor(apiUrl: String) -> String {
    dashboardOriginFor(apiUrl: apiUrl) ?? "https://virvi.io"
}

/// The scene's analytics page (the Stats tab). Plain link: the headset never mints a web hand-off.
func analyticsUrlFor(apiUrl: String, sceneId: String) -> String {
    "\(dashboardUrlFor(apiUrl: apiUrl))/analytics/?scene=\(encodeURIComponent(sceneId))"
}

/// JavaScript's `encodeURIComponent`: everything but ASCII letters, digits and `-_.!~*'()` is percent-encoded.
func encodeURIComponent(_ s: String) -> String {
    var allowed = CharacterSet()
    allowed.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}
