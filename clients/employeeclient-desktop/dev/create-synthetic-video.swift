// Synthetic offline fixture. No camera, microphone, user media or network.
import Foundation
import AVFoundation
import CoreVideo

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: 64, AVVideoHeightKey: 64
])
let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
    sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                                 kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
writer.add(input)
guard writer.startWriting() else { fatalError(String(describing: writer.error)) }
writer.startSession(atSourceTime: .zero)
for frame in 0..<10 {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.01) }
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_32ARGB, nil, &buffer)
    let pixel = buffer!
    CVPixelBufferLockBaseAddress(pixel, [])
    let data = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(pixel)
    for y in 0..<64 { for x in 0..<64 {
        let offset = y * stride + x * 4
        data[offset] = 255; data[offset + 1] = UInt8(frame * 20)
        data[offset + 2] = 170; data[offset + 3] = 80
    }}
    CVPixelBufferUnlockBaseAddress(pixel, [])
    guard adapter.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)) else {
        fatalError(String(describing: writer.error))
    }
}
input.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()
guard writer.status == .completed else { fatalError(String(describing: writer.error)) }
print("Synthetic MP4 written: \(url.path)")
