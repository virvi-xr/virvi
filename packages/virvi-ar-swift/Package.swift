// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "VirviARKit",
    platforms: [.iOS(.v18), .visionOS(.v2)],
    products: [
        .library(name: "VirviARKit", targets: ["VirviARKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/warrenm/GLTFKit2", exact: "0.5.15"),
    ],
    targets: [
        .target(
            name: "VirviARKit",
            dependencies: [.product(name: "GLTFKit2", package: "GLTFKit2")]
        ),
        .testTarget(
            name: "VirviARKitTests",
            dependencies: ["VirviARKit"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
