import Foundation

actor PDFFileResolver {
    private var cache: [String: URL] = [:]
    private var indexedFolder: URL?

    func reset() {
        cache.removeAll()
        indexedFolder = nil
    }

    func find(fileName: String, inside folder: URL) throws -> URL? {
        let key = normalize(fileName)
        if indexedFolder == folder, let cached = cache[key], FileManager.default.fileExists(atPath: cached.path) { return cached }
        cache.removeAll()
        indexedFolder = folder
        let keys: [URLResourceKey] = [.isRegularFileKey, .nameKey]
        guard let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return nil }
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: Set(keys))
            guard values?.isRegularFile == true, url.pathExtension.caseInsensitiveCompare("pdf") == .orderedSame else { continue }
            let candidateKey = normalize(values?.name ?? url.lastPathComponent)
            if cache[candidateKey] == nil { cache[candidateKey] = url }
        }
        return cache[key]
    }

    func prepareUbiquitousFile(_ url: URL) async throws {
        let values = try url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey])
        guard values.isUbiquitousItem == true else { return }
        if values.ubiquitousItemDownloadingStatus == .current { return }
        try FileManager.default.startDownloadingUbiquitousItem(at: url)
        for _ in 0..<120 {
            try await Task.sleep(for: .milliseconds(250))
            let status = try url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]).ubiquitousItemDownloadingStatus
            if status == .current { return }
        }
        throw CocoaError(.fileReadUnknown)
    }

    private func normalize(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping.lowercased(with: Locale(identifier: "en_US_POSIX"))
    }
}
