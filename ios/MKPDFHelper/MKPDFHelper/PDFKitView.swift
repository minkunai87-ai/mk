import PDFKit
import SwiftUI

struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    let request: PDFOpenRequest

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.usePageViewController(false)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document; view.autoScales = true }
        guard context.coordinator.lastRequest != request,
              let page = document.page(at: request.page - 1) else { return }
        context.coordinator.lastRequest = request
        DispatchQueue.main.async {
            if let rect = request.rect, let sourceSize = request.sourcePageSize,
               let pdfRect = PDFCoordinateConverter.convertLogseqRect(rect, sourcePageSize: sourceSize, page: page) {
                view.go(to: pdfRect.insetBy(dx: -12, dy: -12), on: page)
                context.coordinator.flash(rect: pdfRect, page: page, in: view)
            } else {
                view.go(to: page)
            }
        }
    }

    final class Coordinator {
        var lastRequest: PDFOpenRequest?
        func flash(rect: CGRect, page: PDFPage, in pdfView: PDFView) {
            let overlay = UIView(frame: pdfView.convert(rect, from: page).insetBy(dx: -4, dy: -4))
            overlay.backgroundColor = UIColor.systemYellow.withAlphaComponent(0.38)
            overlay.layer.borderColor = UIColor.systemOrange.cgColor
            overlay.layer.borderWidth = 2
            overlay.layer.cornerRadius = 4
            overlay.isUserInteractionEnabled = false
            pdfView.addSubview(overlay)
            UIView.animate(withDuration: 0.35, delay: 0.95, options: [.curveEaseOut]) {
                overlay.alpha = 0
            } completion: { _ in overlay.removeFromSuperview() }
        }
    }
}
