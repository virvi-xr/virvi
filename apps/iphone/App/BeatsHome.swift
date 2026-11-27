import Observation
import SwiftUI
import VirviARKit

/// The app's two tabs: BEATs (the home screen, where it opens) and Scan (the camera).
enum AppTab: Hashable { case beats, scan }

/// Which tab is up and which BEAT is open on the BEATs tab. The camera runs only while Scan is up.
@MainActor
@Observable
final class AppNav {
    var tab: AppTab = .beats
    /// The BEATs tab's navigation: the ids of the BEATs opened, at most one.
    var path: [String] = []

    func scan() { tab = .scan }

    /// Shows one BEAT's page on the BEATs tab (a tapped row, or a tapped reminder).
    func showBeat(_ id: String) {
        tab = .beats
        path = [id]
    }

    func cameraRuns(active: Bool) -> Bool { active && tab == .scan }
}

enum HomeCopy {
    static let TITLE = "BEATs"
    static let SCAN_TAB = "Scan"
    static let SCAN_ARC = "Scan an ARC"
    static let SIGNED_OUT_HEADLINE = "Collect BEATs"
    static let SIGNED_OUT_BODY = "Earn a BEAT by spending time at an event or in an AR space. Sign in to start collecting."
    static let SCAN_HINT = "At an event or in an AR space? Scan its ARC to check in."
    static let ACCOUNT = "Account"
}

/// The home screen: signed out, what BEATs are and how to sign in; signed in, the visitor's BEATs, each opening its
/// page (track, claim). "Scan an ARC" goes to the camera.
struct BeatsHome: View {
    let model: AppModel
    @Bindable var nav: AppNav
    @State private var signingInWithCode = false
    @State private var signingHeadsetIn = false

    var body: some View {
        let signIn = model.signIn
        NavigationStack(path: $nav.path) {
            Group {
                if signIn.signedIn { signedIn } else { signedOut }
            }
            .navigationTitle(HomeCopy.TITLE)
            .toolbar {
                if signIn.signedIn {
                    ToolbarItem(placement: .topBarTrailing) { accountMenu }
                }
            }
            .navigationDestination(for: String.self) { id in
                BeatPage(beatId: id, beats: model.beats)
            }
        }
        .sheet(isPresented: $signingInWithCode) {
            CodeSignInView(model: CodeSignInModel(session: signIn.session)) { signingInWithCode = false }
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $signingHeadsetIn) {
            HeadsetSignInView(model: HeadsetSignInModel(session: signIn.session)) { signingHeadsetIn = false }
                .presentationDetents([.medium])
        }
    }

    private var signedOut: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "star.circle.fill").font(.system(size: 56)).foregroundStyle(.orange)
                Text(HomeCopy.SIGNED_OUT_HEADLINE).font(.title2.weight(.semibold))
                Text(HomeCopy.SIGNED_OUT_BODY).foregroundStyle(.secondary)
                wide(VisitorCopy.MENU_SIGN_IN, prominent: true) { model.signIn.signIn() }
                wide(CodeSignInModel.TITLE) { signingInWithCode = true }
                if let message = model.signIn.message {
                    Text(message).font(.footnote).foregroundStyle(.secondary)
                }
                Divider().padding(.vertical, 6)
                Text(HomeCopy.SCAN_HINT).font(.subheadline).foregroundStyle(.secondary)
                wide(HomeCopy.SCAN_ARC) { nav.scan() }
            }
            .padding(20)
        }
    }

    private var signedIn: some View {
        let myBeats = model.myBeats
        return List {
            Section {
                Button { nav.scan() } label: {
                    Label(HomeCopy.SCAN_ARC, systemImage: "viewfinder").font(.headline)
                }
            } footer: { Text(HomeCopy.SCAN_HINT) }
            Section {
                switch myBeats.phase {
                case .idle, .loading: ProgressView().frame(maxWidth: .infinity)
                case .failed(let message): Text(message).foregroundStyle(.secondary)
                case .loaded(let rows):
                    if rows.isEmpty { Text(MyBeatsModel.EMPTY).foregroundStyle(.secondary) }
                    ForEach(rows) { row in
                        if row.opens {
                            Button {
                                myBeats.open(row)
                                nav.showBeat(row.id)
                            } label: { BeatRow(row: row, opens: true) }
                                .buttonStyle(.plain)
                        } else {
                            BeatRow(row: row, opens: false)
                        }
                    }
                }
            } header: { Text(MyBeatsModel.TITLE) }
        }
        .refreshable { await myBeats.load() }
        // Again on each return to the list: a claim made on a BEAT's page shows here at once
        .task(id: nav.path.isEmpty) { if nav.path.isEmpty { await myBeats.load() } }
    }

    private var accountMenu: some View {
        Menu {
            if let name = model.signIn.userName { Text(name) }
            Button(VisitorMenu.SIGN_HEADSET_IN) { signingHeadsetIn = true }
            Button(VisitorMenu.SIGN_OUT, role: .destructive) { model.signIn.signOut() }
        } label: {
            Image(systemName: "person.crop.circle").accessibilityLabel(HomeCopy.ACCOUNT)
        }
    }

    private func wide(_ label: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Group {
            if prominent {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            } else {
                Button(action: action) { Text(label).frame(maxWidth: .infinity) }.buttonStyle(.bordered)
            }
        }
        .controlSize(.large)
    }
}

/// One of the visitor's BEATs in the list: its picture, name and where it stands.
struct BeatRow: View {
    let row: MyBeatsModel.Row
    let opens: Bool

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: URL(string: row.card.imageUrl)) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Image(systemName: "star.circle").font(.system(size: 28)).foregroundStyle(.secondary)
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).font(.headline)
                if let s = row.status { Text(s).font(.subheadline).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if opens { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary) }
        }
        .contentShape(Rectangle())
    }
}

/// One BEAT's page: its picture and its card (track, claim, the wallet choice), without the camera.
struct BeatPage: View {
    let beatId: String
    let beats: BeatModel

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let current = beats.current, beats.origin == .beat(beatId) {
                    AsyncImage(url: URL(string: current.imageUrl)) { image in
                        image.resizable().scaledToFit()
                    } placeholder: { Color.clear.frame(height: 1) }
                        .frame(maxHeight: 280)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                    BeatCardView(model: beats, showsClose: false)
                } else {
                    ProgressView().padding(.top, 40)
                }
            }
            .padding(16)
        }
        .navigationBarTitleDisplayMode(.inline)
        // Leaving the page puts the card away, so it doesn't follow the visitor onto the camera
        .onDisappear { if beats.origin == .beat(beatId) { beats.closeEvent() } }
    }
}
