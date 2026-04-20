#!/usr/bin/env python3
"""PaddleOCR runner — called by winrpc /ocr endpoint.

Usage: python ocr.py <image_path> [lang=ch]
Output: JSON array of {text, confidence, x1, y1, x2, y2}
"""
import sys
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps([]), flush=True)
        return

    image_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "ch"

    import os
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    from paddleocr import PaddleOCR  # lazy import so startup is fast when checking
    import paddleocr as _pocr_mod
    _ver = tuple(int(x) for x in getattr(_pocr_mod, "__version__", "2.0.0").split(".")[:2])
    if _ver >= (3, 0):
        # PaddleOCR 3.x API
        ocr = PaddleOCR(use_textline_orientation=True, lang=lang, ocr_version="PP-OCRv4")
        result = ocr.ocr(image_path)
    else:
        # PaddleOCR 2.x API
        ocr = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
        result = ocr.ocr(image_path, cls=True)

    boxes = []
    if result:
        for page in result:
            if not page:
                continue
            for item in page:
                bbox = item[0]   # [[x1,y1],[x2,y1],[x2,y2],[x1,y2]]
                text, conf = item[1]
                boxes.append({
                    "text": text,
                    "confidence": round(float(conf), 4),
                    "x1": int(bbox[0][0]),
                    "y1": int(bbox[0][1]),
                    "x2": int(bbox[2][0]),
                    "y2": int(bbox[2][1]),
                })

    # Write UTF-8 bytes directly to avoid Windows CP1252 console encoding issues
    out = json.dumps(boxes, ensure_ascii=False)
    sys.stdout.buffer.write(out.encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()

if __name__ == "__main__":
    main()
