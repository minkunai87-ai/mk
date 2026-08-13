import CoreGraphics
import Foundation

struct PDFOpenRequest: Equatable {
    let fileName: String
    let page: Int
    let annotationId: String?
    let rect: CGRect?
    let sourcePageSize: CGSize?

    init?(url: URL) {
        guard url.scheme?.lowercased() == "mkpdf", url.host?.lowercased() == "open",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let values = Dictionary(uniqueKeysWithValues: components.queryItems?.compactMap { item in
            item.value.map { (item.name, $0) }
        } ?? [])
        guard let fileName = values["file"]?.removingPercentEncoding,
              !fileName.isEmpty,
              let pageValue = values["page"], let page = Int(pageValue), page > 0 else { return nil }
        self.fileName = fileName
        self.page = page
        annotationId = values["annotation"]

        func number(_ key: String) -> CGFloat? {
            values[key].flatMap(Double.init).map(CGFloat.init)
        }
        if let x = number("x"), let y = number("y"), let width = number("width"), let height = number("height"),
           width > 0, height > 0 {
            rect = CGRect(x: x, y: y, width: width, height: height)
        } else {
            rect = nil
        }
        if let width = number("sourceWidth"), let height = number("sourceHeight"), width > 0, height > 0 {
            sourcePageSize = CGSize(width: width, height: height)
        } else {
            sourcePageSize = nil
        }
    }
}
