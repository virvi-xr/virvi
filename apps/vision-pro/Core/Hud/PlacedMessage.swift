import Foundation

/// What the scene's World destination reports (GET /api/scenes/:id/dcl/publish-status, `destination`).
struct PublishDestination: Decodable, Equatable {
    let id: String
    let world: String
    /// "virvi" or "sign".
    let mode: String
    let status: String
    let granted: Bool
    let pending: Int
    let publishUrl: String
}

/// Port of packages/core/src/placed-message.ts: the line after a model is placed.
func placedMessage(name: String, destination d: PublishDestination?) -> (text: String, publish: Bool) {
    let placed = "Placed \(name) —"
    guard let d else {
        return ("\(placed) to get it into your World, open this scene's Deploy page in Virvi Studio, or run npx @virvixr/dcl sync and redeploy", false)
    }
    if d.status == "over_budget" { return ("\(placed) the scene is past Decentraland's limits for this plot, so it can't go live until something is removed", false) }
    if d.status == "needs_review" { return ("\(placed) deploys to your World are paused; check this scene's Deploy page in Virvi Studio", false) }
    if d.mode == "sign" { return ("\(placed) publish it to see it in your World", true) }
    if !d.granted { return ("\(placed) Virvi needs your permission to deploy it; give it on this scene's Deploy page in Virvi Studio", false) }
    return ("\(placed) Virvi is adding it to your World; it appears in a minute or two", false)
}
