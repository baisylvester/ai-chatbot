// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ChatbotKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ChatbotKit", targets: ["ChatbotKit"])],
    targets: [.target(name: "ChatbotKit"), .testTarget(name: "ChatbotKitTests", dependencies: ["ChatbotKit"])]
)
