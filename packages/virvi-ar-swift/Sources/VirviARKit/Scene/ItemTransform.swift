import Foundation

/// An instance's transform as Virvi stores it (Decentraland scene-local, degrees). `RenderItem.source` carries it, and
/// the Vision Pro builder's edits start from it.
public struct ItemTransform: Equatable {
    public var position: SIMD3<Double>
    public var rotation: SIMD3<Double>
    public var scale: SIMD3<Double>

    public init(position: SIMD3<Double>, rotation: SIMD3<Double>, scale: SIMD3<Double>) {
        self.position = position
        self.rotation = rotation
        self.scale = scale
    }
}
