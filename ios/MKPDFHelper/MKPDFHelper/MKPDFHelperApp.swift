import SwiftUI

@main
struct MKPDFHelperApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
                .onOpenURL { model.handleIncomingURL($0) }
        }
    }
}
