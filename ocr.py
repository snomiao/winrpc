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
    # PaddleOCR 3.x: use_textline_orientation replaces use_angle_cls; show_log removed
    ocr = PaddleOCR(use_textline_orientation=True, lang=lang)
    result = ocr.ocr(image_path)

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

    print(json.dumps(boxes, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
