import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// A QR code of `text` (CoreImage CIQRCodeGenerator), drawn crisp, dark on white with a quiet zone.
struct QRCodeView: View {
    let text: String
    var size: CGFloat = 220

    var body: some View {
        Group {
            if let image = Self.image(for: text) {
                Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
            } else {
                Color.white
            }
        }
        .frame(width: size, height: size)
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
    }

    static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
