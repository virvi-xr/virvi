import SwiftUI
import WebKit

/// A browser window beside the HUD for the upload page, analytics and Publish (where the builder signs in on the
/// web themselves; the headset never hands a session over).
struct BrowserWindow: View {
    let url: URL

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(url.host() ?? url.absoluteString).font(.system(size: 14)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                Link("Open in Safari", destination: url).font(.system(size: 14))
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            WebView(url: url)
        }
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let view = WKWebView(frame: .zero, configuration: config)
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        if view.url == nil { view.load(URLRequest(url: url)) }
    }
}
