#!/usr/bin/env python3
"""macOS Vision OCR runner — runs on Mac, processes images from Windows screenshots.

Usage: python3 ocr-mac.py <image_path> [lang=zh-Hans,en-US,ja]
Output: JSON array of {text, confidence, x1, y1, x2, y2}

Requires: pip install pyobjc-framework-Vision
"""
import sys
import json
import os

def ocr_via_vision(image_path: str, languages: list[str]) -> list[dict]:
    import Vision
    import Quartz
    import objc
    from Foundation import NSURL, NSArray

    url = NSURL.fileURLWithPath_(os.path.abspath(image_path))
    handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, {})

    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(True)
    if languages:
        request.setRecognitionLanguages_(languages)

    success, error = handler.performRequests_error_([request], None)
    if not success:
        raise RuntimeError(f"Vision request failed: {error}")

    results = []
    for obs in (request.results() or []):
        text = obs.topCandidates_(1)[0].string()
        conf = obs.topCandidates_(1)[0].confidence()
        box = obs.boundingBox()  # normalized, origin bottom-left
        # Get image size to convert normalized coords
        results.append({
            "text": text,
            "confidence": round(float(conf), 4),
            # Store as normalized [0,1] coords; caller can scale if needed
            # x1,y1 = top-left in image coords (y flipped from Vision's bottom-left origin)
            "x1_norm": round(box.origin.x, 4),
            "y1_norm": round(1.0 - box.origin.y - box.size.height, 4),
            "x2_norm": round(box.origin.x + box.size.width, 4),
            "y2_norm": round(1.0 - box.origin.y, 4),
        })
    return results


def main():
    if len(sys.argv) < 2:
        sys.stdout.buffer.write(b"[]\n")
        return

    image_path = sys.argv[1]
    lang_arg = sys.argv[2] if len(sys.argv) > 2 else "zh-Hans,en-US,ja"
    languages = [l.strip() for l in lang_arg.split(",") if l.strip()]

    boxes = ocr_via_vision(image_path, languages)
    out = json.dumps(boxes, ensure_ascii=False)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
