import { join } from "path";
import { existsSync } from "fs";

export interface OcrBox {
  text: string;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface OcrResult {
  ok: boolean;
  boxes: OcrBox[];
  text: string;
}

const SCRIPT_DIR = join(import.meta.dir, "..");
const OCR_PY = join(SCRIPT_DIR, "ocr.py");

// Candidate python executables in priority order
const PYTHON_CANDIDATES = [
  "C:\\Users\\snomi\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
  "C:\\Users\\snomi\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
  "C:\\Users\\snomi\\AppData\\Local\\Programs\\Python\\Python312\\python.exe",
  "C:\\Python310\\python.exe",
  "C:\\Python311\\python.exe",
  "C:\\Python312\\python.exe",
  "python3",
  "python",
];

let _pythonExe: string | null = null;

function findPython(): string {
  if (_pythonExe) return _pythonExe;
  for (const cand of PYTHON_CANDIDATES) {
    if (!cand.includes("\\") || existsSync(cand)) {
      _pythonExe = cand;
      return cand;
    }
  }
  return "python";
}

export async function runOcr(imagePath: string, lang = "ch"): Promise<OcrResult> {
  const py = findPython();
  const proc = Bun.spawn([py, OCR_PY, imagePath, lang], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: SCRIPT_DIR,
    env: {
      ...process.env,
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`OCR process failed (code ${code}): ${stderr.slice(0, 500)}`);
  }
  const boxes: OcrBox[] = JSON.parse(stdout);
  const text = boxes.map((b) => b.text).join("\n");
  return { ok: true, boxes, text };
}
