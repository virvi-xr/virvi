import CoreLocation
import Foundation
import VirviARKit

/// What asking for the phone's position gave.
enum LocationOutcome: Equatable {
    case fix(BeatLocation)
    /// Location is off for the app (or restricted): the visitor has to allow it in Settings.
    case denied
    /// No usable fix in time.
    case unavailable
}

/// Gives the phone's position when a BEAT needs it (`VenueLocation` on the phone; a fake in tests).
@MainActor
protocol LocationProvider: AnyObject {
    func fix() async -> LocationOutcome
}

/// One position fix for a BEAT's venue check: "While using the app", the best accuracy, and no more than 10 seconds
/// for the answer. Asked at check-in and at claim only; nothing is kept and nothing runs in between.
@MainActor
final class VenueLocation: NSObject, LocationProvider, CLLocationManagerDelegate {
    static let timeoutS: Double = 10

    private let manager = CLLocationManager()
    private var waiting: CheckedContinuation<LocationOutcome, Never>?
    private var deadline: Task<Void, Never>?
    private var best: CLLocation?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func fix() async -> LocationOutcome {
        // One question at a time: a new ask replaces one still open, which gets "unavailable"
        if let waiting { waiting.resume(returning: .unavailable) }
        return await withCheckedContinuation { c in
            waiting = c
            best = nil
            deadline?.cancel()
            deadline = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.timeoutS * 1_000_000_000))
                if !Task.isCancelled { self?.timedOut() }
            }
            begin()
        }
    }

    private func begin() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .denied, .restricted: finish(.denied)
        default: manager.requestLocation()
        }
    }

    private func timedOut() {
        finish(best.flatMap(Self.usable).map(LocationOutcome.fix) ?? .unavailable)
    }

    private func finish(_ outcome: LocationOutcome) {
        deadline?.cancel()
        deadline = nil
        manager.stopUpdatingLocation()
        let c = waiting
        waiting = nil
        c?.resume(returning: outcome)
    }

    private static func usable(_ l: CLLocation) -> BeatLocation? {
        guard l.horizontalAccuracy >= 0 else { return nil }
        return BeatLocation(lat: l.coordinate.latitude, lng: l.coordinate.longitude, accuracyM: l.horizontalAccuracy)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        MainActor.assumeIsolated {
            guard waiting != nil else { return }
            switch status {
            case .denied, .restricted: finish(.denied)
            case .authorizedWhenInUse, .authorizedAlways: self.manager.requestLocation()
            default: break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let last = locations.last else { return }
        MainActor.assumeIsolated {
            best = last
            finish(Self.usable(last).map(LocationOutcome.fix) ?? .unavailable)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        MainActor.assumeIsolated { finish(denied ? .denied : .unavailable) }
    }
}
