import CoreGraphics
import PDFKit

enum PDFCoordinateConverter {
    static func convertLogseqRect(_ rect: CGRect, sourcePageSize: CGSize, page: PDFPage) -> CGRect? {
        guard sourcePageSize.width > 0, sourcePageSize.height > 0 else { return nil }
        // The verified MK sample is an unrotated PDF.js top-left coordinate space.
        // Fail closed for rotated source pages until a rotated fixture is measured.
        guard ((page.rotation % 360) + 360) % 360 == 0 else { return nil }
        let bounds = page.bounds(for: .cropBox)
        let scaleX = bounds.width / sourcePageSize.width
        let scaleY = bounds.height / sourcePageSize.height
        return CGRect(
            x: bounds.minX + rect.minX * scaleX,
            y: bounds.minY + (sourcePageSize.height - rect.maxY) * scaleY,
            width: rect.width * scaleX,
            height: rect.height * scaleY
        )
    }
}
