import CoreLocation
import Foundation
import VirviARKit

/// What asking for the phone's position gave.
enum LocationOutcome: Equatable {
    case fix(BeatLocation)
    /// Location is off for the app (or restricted): the visitor has to allow it in Settings.
    case denied
    /// Allowed, but only approximately (Precise Location is off): the visitor has to turn it on in Settings.
    case reduced
    /// No usable fix in time.
    case unavailable
}

/// Gives the phone's position when a BEAT needs it (`VenueLocation` on the phone; a fake in tests).
@MainActor
protocol LocationProvider: AnyObject {
    func fix() async -> LocationOutcome
}

enum LocationAuthorization: Equatable {
    case notDetermined, denied, reduced, full
}

/// The part of `CLLocationManager` the fix uses (a fake in tests).
@MainActor
protocol LocationManaging: AnyObject {
    var authorization: LocationAuthorization { get }
    /// Set by `VenueLocation`: the authorization changed, a fix arrived, the request failed.
    var onAuthorizationChange: (() -> Void)? { get set }
    var onLocation: ((CLLocation) -> Void)? { get set }
    var onError: ((Error) -> Void)? { get set }
    func requestPermission()
    func requestOne()
}

@MainActor
final class SystemLocationManager: NSObject, LocationManaging, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    var onAuthorizationChange: (() -> Void)?
    var onLocation: ((CLLocation) -> Void)?
    var onError: ((Error) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    var authorization: LocationAuthorization {
        switch manager.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .denied, .restricted: return .denied
        default: return manager.accuracyAuthorization == .reducedAccuracy ? .reduced : .full
        }
    }

    func requestPermission() { manager.requestWhenInUseAuthorization() }
    func requestOne() { manager.requestLocation() }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated { onAuthorizationChange?() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        MainActor.assumeIsolated { onLocation?(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated { onError?(error) }
    }
}

/// One position fix for a BEAT's venue check: "While using the app", the best accuracy, and no more than 10 seconds
/// for the answer, counted from the moment the position is asked for (not while the visitor is still answering the
/// permission prompt). Asked at check-in and claim only; nothing is kept and nothing runs in between.
@MainActor
final class VenueLocation: LocationProvider {
    static let timeoutS: Double = 10

    private let manager: LocationManaging
    private let sleep: @Sendable (Double) async -> Void
    private var waiting: CheckedContinuation<LocationOutcome, Never>?
    private var deadline: Task<Void, Never>?

    init(manager: LocationManaging? = nil,
         sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        let manager = manager ?? SystemLocationManager()
        self.manager = manager
        self.sleep = sleep
        manager.onAuthorizationChange = { [weak self] in self?.authorizationChanged() }
        manager.onLocation = { [weak self] l in
            self?.finish(l.horizontalAccuracy >= 0
                         ? .fix(BeatLocation(lat: l.coordinate.latitude, lng: l.coordinate.longitude, accuracyM: l.horizontalAccuracy))
                         : .unavailable)
        }
        manager.onError = { [weak self] e in self?.finish((e as? CLError)?.code == .denied ? .denied : .unavailable) }
    }

    func fix() async -> LocationOutcome {
        // One question at a time: a new ask replaces one still open, which gets "unavailable"
        finish(.unavailable)
        return await withCheckedContinuation { c in
            waiting = c
            if manager.authorization == .notDetermined { manager.requestPermission() } else { proceed() }
        }
    }

    private func authorizationChanged() {
        // Only an answer to the prompt while a fix waits for it (not one that is already being fetched)
        guard waiting != nil, deadline == nil, manager.authorization != .notDetermined else { return }
        proceed()
    }

    private func proceed() {
        switch manager.authorization {
        case .notDetermined: break
        case .denied: finish(.denied)
        case .reduced: finish(.reduced)
        case .full:
            let sleep = sleep
            deadline = Task { [weak self] in
                await sleep(Self.timeoutS)
                if !Task.isCancelled { self?.finish(.unavailable) }
            }
            manager.requestOne()
        }
    }

    private func finish(_ outcome: LocationOutcome) {
        deadline?.cancel()
        deadline = nil
        let c = waiting
        waiting = nil
        c?.resume(returning: outcome)
    }
}
