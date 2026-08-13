import Combine
import Foundation
import PDFKit

@MainActor
final class AppModel: ObservableObject {
    enum State: Equatable {
        case needsFolder, ready, loading(String), viewing, error(String)
    }

    @Published private(set) var state: State = .needsFolder
    @Published private(set) var folderURL: URL?
    @Published private(set) var document: PDFDocument?
    @Published private(set) var openRequest: PDFOpenRequest?
    @Published var showsFolderPicker = false

    private let bookmarks = BookmarkStore()
    private let resolver = PDFFileResolver()
    private var pendingRequest: PDFOpenRequest?
    private var securityScopedFolder: URL?

    init() {
        do {
            if let url = try bookmarks.restore(), url.startAccessingSecurityScopedResource() {
                securityScopedFolder = url
                folderURL = url
                state = .ready
            }
        } catch {
            state = .error("저장된 PDF 폴더 권한을 복원하지 못했습니다.")
        }
    }

    deinit { securityScopedFolder?.stopAccessingSecurityScopedResource() }

    func handleIncomingURL(_ url: URL) {
        guard let request = PDFOpenRequest(url: url) else {
            state = .error("올바르지 않은 MK PDF 링크입니다.")
            return
        }
        pendingRequest = request
        guard folderURL != nil else { state = .needsFolder; showsFolderPicker = true; return }
        Task { await open(request) }
    }

    func selectFolder(_ url: URL) {
        do {
            securityScopedFolder?.stopAccessingSecurityScopedResource()
            guard url.startAccessingSecurityScopedResource() else { throw CocoaError(.fileReadNoPermission) }
            try bookmarks.save(folderURL: url)
            securityScopedFolder = url
            folderURL = url
            state = .ready
            Task {
                await resolver.reset()
                if let pendingRequest { await open(pendingRequest) }
            }
        } catch {
            state = .error("PDF 폴더 접근 권한을 저장하지 못했습니다.")
        }
    }

    func chooseFolderAgain() { showsFolderPicker = true }

    private func open(_ request: PDFOpenRequest) async {
        guard let folderURL else { pendingRequest = request; state = .needsFolder; return }
        state = .loading(request.fileName)
        do {
            guard let fileURL = try await resolver.find(fileName: request.fileName, inside: folderURL) else {
                state = .error("PDF를 찾을 수 없습니다.\n\n\(request.fileName)")
                return
            }
            try await resolver.prepareUbiquitousFile(fileURL)
            guard let document = PDFDocument(url: fileURL) else { throw CocoaError(.fileReadCorruptFile) }
            guard request.page <= document.pageCount else { throw CocoaError(.fileReadUnknown) }
            self.document = document
            self.openRequest = request
            pendingRequest = nil
            state = .viewing
        } catch {
            state = .error("PDF를 불러오지 못했습니다.\n\n\(request.fileName)")
        }
    }
}
