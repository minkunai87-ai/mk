import PDFKit
import XCTest
@testable import MKPDFHelper

final class PDFCoordinateConverterTests: XCTestCase {
    func testVerifiedFlashPointFixture() throws {
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, CGRect(x: 429, y: 901, width: 825.2, height: 582.55), nil)
        UIGraphicsBeginPDFPage()
        UIGraphicsEndPDFContext()
        let page = try XCTUnwrap(PDFDocument(data: data as Data)?.page(at: 0))
        let source = CGSize(width: 944, height: 666.416868637906)
        let rect = CGRect(x: 175.03675589337945, y: 104.3719482421875, width: 33.99638366699219, height: 11.173553466796875)
        let converted = try XCTUnwrap(PDFCoordinateConverter.convertLogseqRect(rect, sourcePageSize: source, page: page))
        XCTAssertEqual(converted.width, rect.width * page.bounds(for: .cropBox).width / source.width, accuracy: 0.001)
        XCTAssertGreaterThan(converted.minY, page.bounds(for: .cropBox).midY)
    }
}
