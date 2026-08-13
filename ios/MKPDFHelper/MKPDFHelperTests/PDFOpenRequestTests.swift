import XCTest
@testable import MKPDFHelper

final class PDFOpenRequestTests: XCTestCase {
    func testKoreanDeepLink() throws {
        let url = try XCTUnwrap(URL(string: "mkpdf://open?file=2027%20%EC%A0%95%ED%83%9C%EC%84%B1%20%EB%A7%90%EB%9E%91%EB%A7%90%EB%9E%91%20%EC%86%8C%EB%B0%A9%ED%95%99%EA%B0%9C%EB%A1%A0%20%EA%B8%B0%EB%B3%B8%EC%84%9C.pdf&page=40&annotation=6a58769d-6bdc-454b-b744-ef8e39bc9354&x=175.03675589337945&y=104.3719482421875&width=33.99638366699219&height=11.173553466796875&sourceWidth=944&sourceHeight=666.416868637906"))
        let request = try XCTUnwrap(PDFOpenRequest(url: url))
        XCTAssertEqual(request.fileName, "2027 정태성 말랑말랑 소방학개론 기본서.pdf")
        XCTAssertEqual(request.page, 40)
        XCTAssertEqual(request.annotationId, "6a58769d-6bdc-454b-b744-ef8e39bc9354")
        XCTAssertEqual(try XCTUnwrap(request.rect).origin.x, 175.03675589337945, accuracy: 0.0001)
    }

    func testRejectsMissingRequiredValues() {
        XCTAssertNil(PDFOpenRequest(url: URL(string: "mkpdf://open?page=40")!))
        XCTAssertNil(PDFOpenRequest(url: URL(string: "mkpdf://open?file=a.pdf&page=0")!))
    }
}
