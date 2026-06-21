#!/usr/bin/env python3
"""PaddleOCR runner — called by winrpc /ocr and /ocr-stream.

Usage:
  python ocr.py <image_path> [lang=ch]   one-shot: print one JSON array, exit
  python ocr.py --serve [lang=ch]        warm worker: keep model loaded, read
                                          one image path per stdin line, print
                                          one JSON array per line (flushed)

Output box shape: {text, confidence, x1, y1, x2, y2} (pixel coords, no rotation).
"""
import sys
import json
import os


def build_ocr(lang):
    """Load PaddleOCR once. Returns (ocr, major_version)."""
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    # Shared GPU (the game + desktop already use most of an 8 GB card): paddle
    # otherwise pre-grabs ~92% of GPU memory at init and OOMs. auto_growth makes
    # it allocate only what the (small) OCR models need.
    os.environ.setdefault("FLAGS_allocator_strategy", "auto_growth")
    os.environ.setdefault("FLAGS_fraction_of_gpu_memory_to_use", "0")
    # OCR_DEVICE=cpu forces CPU even when a GPU build is installed (fallback when
    # VRAM is exhausted). Default: let paddle pick (GPU if available).
    _device = os.environ.get("OCR_DEVICE", "").strip().lower()
    if _device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
    elif hasattr(os, "add_dll_directory"):
        # Windows GPU build: the bundled CUDA DLLs live in site-packages/nvidia/
        # */bin. When this process is *spawned* (vs an interactive shell), a
        # conflicting cusparse/cublas on PATH can win and cause WinError 127.
        # Register the bundled dirs explicitly so the matching versions load.
        import glob
        import site
        roots = list(site.getsitepackages()) if hasattr(site, "getsitepackages") else []
        roots.append(os.path.dirname(os.path.dirname(__file__)))  # python lib dir fallback
        seen = set()
        for sp in roots:
            for d in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
                if os.path.isdir(d) and d not in seen:
                    seen.add(d)
                    try:
                        os.add_dll_directory(d)
                    except OSError:
                        pass
    from paddleocr import PaddleOCR
    import paddleocr as _pocr_mod
    ver = tuple(int(x) for x in getattr(_pocr_mod, "__version__", "2.0.0").split(".")[:2])
    if ver >= (3, 0):
        # Disable oneDNN/MKLDNN: paddle 3.3.1's PIR executor crashes in the
        # oneDNN path on this CPU build. Fall back if the kwarg is unsupported.
        try:
            ocr = PaddleOCR(use_textline_orientation=True, lang=lang,
                            ocr_version="PP-OCRv4", enable_mkldnn=False)
        except TypeError:
            ocr = PaddleOCR(use_textline_orientation=True, lang=lang, ocr_version="PP-OCRv4")
    else:
        ocr = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
    return ocr, ver


def recognize(ocr, ver, image_path):
    """Run OCR on one image, return a list of box dicts."""
    boxes = []
    if ver >= (3, 0):
        for res in ocr.predict(image_path):
            texts = res["rec_texts"]
            scores = res["rec_scores"]
            polys = res.get("rec_polys")
            if polys is None:
                polys = res.get("dt_polys", [])
            for text, conf, poly in zip(texts, scores, polys):
                xs = [int(pt[0]) for pt in poly]
                ys = [int(pt[1]) for pt in poly]
                boxes.append({
                    "text": text, "confidence": round(float(conf), 4),
                    "x1": min(xs), "y1": min(ys), "x2": max(xs), "y2": max(ys),
                })
    else:
        for page in (ocr.ocr(image_path, cls=True) or []):
            if not page:
                continue
            for item in page:
                bbox = item[0]
                text, conf = item[1]
                boxes.append({
                    "text": text, "confidence": round(float(conf), 4),
                    "x1": int(bbox[0][0]), "y1": int(bbox[0][1]),
                    "x2": int(bbox[2][0]), "y2": int(bbox[2][1]),
                })
    return boxes


def emit(boxes):
    # Write UTF-8 bytes directly to dodge Windows CP1252 console encoding.
    sys.stdout.buffer.write(json.dumps(boxes, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--serve":
        lang = sys.argv[2] if len(sys.argv) > 2 else "ch"
        ocr, ver = build_ocr(lang)
        emit([])  # readiness signal: empty line once the model is loaded
        for line in sys.stdin:
            path = line.strip()
            if not path:
                continue
            try:
                emit(recognize(ocr, ver, path))
            except Exception as e:
                sys.stderr.write(f"ocr-serve error: {e}\n")
                sys.stderr.flush()
                emit([])
        return

    if len(sys.argv) < 2:
        emit([])
        return
    image_path = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "ch"
    ocr, ver = build_ocr(lang)
    emit(recognize(ocr, ver, image_path))


if __name__ == "__main__":
    main()
