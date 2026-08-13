import Foundation

struct BookmarkStore {
    private let defaults: UserDefaults
    private let key = "mkpdf.folderBookmark.v1"

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func save(folderURL: URL) throws {
        let data = try folderURL.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
        defaults.set(data, forKey: key)
    }

    func restore() throws -> URL? {
        guard let data = defaults.data(forKey: key) else { return nil }
        var stale = false
        let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope], relativeTo: nil, bookmarkDataIsStale: &stale)
        if stale { try save(folderURL: url) }
        return url
    }
}
