import Foundation

enum AppConfig {
    static let productionBaseUrl = URL(string: "https://virvi.io")!

    /// Release builds always use https://virvi.io. Debug builds accept `-baseUrl <url>`
    /// as a launch argument (it lands in UserDefaults' argument domain).
    static var baseUrl: URL {
        #if DEBUG
        if let s = UserDefaults.standard.string(forKey: "baseUrl"), let u = URL(string: s), u.scheme != nil {
            return u
        }
        #endif
        return productionBaseUrl
    }
}
