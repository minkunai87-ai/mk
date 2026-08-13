import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Group {
                if let document = model.document, let request = model.openRequest, model.state == .viewing {
                    PDFKitView(document: document, request: request)
                } else {
                    statusView
                }
            }
            .navigationTitle("MK PDF Helper")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("폴더 다시 선택") { model.chooseFolderAgain() }
                }
            }
            .sheet(isPresented: $model.showsFolderPicker) {
                FolderPicker { url in model.showsFolderPicker = false; model.selectFolder(url) }
            }
        }
    }

    @ViewBuilder private var statusView: some View {
        VStack(spacing: 18) {
            Text("MK PDF Helper").font(.title2.bold())
            switch model.state {
            case .needsFolder:
                Text("PDF 폴더가 연결되지 않았습니다.").foregroundStyle(.secondary)
                Button("iCloud PDF 폴더 선택") { model.showsFolderPicker = true }.buttonStyle(.borderedProminent)
            case .ready:
                Text("현재 연결된 PDF 폴더").foregroundStyle(.secondary)
                Text(model.folderURL?.lastPathComponent ?? "-").font(.headline)
            case .loading(let file):
                ProgressView("PDF 불러오는 중…")
                Text(file).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            case .error(let message):
                Text(message).multilineTextAlignment(.center)
                Button("PDF 폴더 다시 선택") { model.showsFolderPicker = true }.buttonStyle(.borderedProminent)
            case .viewing:
                EmptyView()
            }
        }
        .padding(24)
    }
}
