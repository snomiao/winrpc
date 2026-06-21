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

// ── warm worker (keeps the PaddleOCR model loaded for streaming) ──────────────
// `python ocr.py --serve <lang>` loads the model once, then reads one image
// path per stdin line and prints one JSON-array line per frame. Re-spawning per
// frame would reload the model (seconds) — fatal for a poll loop.
class OcrWorker {
  private proc: ReturnType<typeof Bun.spawn>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = "";
  private dec = new TextDecoder();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;

  constructor(lang: string) {
    const py = findPython();
    this.proc = Bun.spawn([py, OCR_PY, "--serve", lang], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: SCRIPT_DIR,
      env: { ...process.env, PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True" },
    });
    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    this.ready = this.readLine().then(() => undefined); // first line = readiness ([])
  }

  private async readLine(): Promise<string> {
    let i: number;
    while ((i = this.buf.indexOf("\n")) < 0) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("ocr worker stdout closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
    const line = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    return line;
  }

  /** OCR an image path through the warm process (serialized — one frame at a time). */
  recognize(imagePath: string): Promise<OcrResult> {
    const run = async (): Promise<OcrResult> => {
      await this.ready;
      (this.proc.stdin as { write(s: string): void; flush?(): void }).write(imagePath + "\n");
      (this.proc.stdin as { flush?(): void }).flush?.();
      const boxes = JSON.parse(await this.readLine()) as OcrBox[];
      return { ok: true, boxes, text: boxes.map((b) => b.text).join("\n") };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  kill() { try { this.proc.kill(); } catch {} }
}

const _workers = new Map<string, OcrWorker>();
export function getOcrWorker(lang = "ch"): OcrWorker {
  let w = _workers.get(lang);
  if (!w) { w = new OcrWorker(lang); _workers.set(lang, w); }
  return w;
}

// ── diff (appeared / disappeared text boxes between two frames) ───────────────
export interface BoxDiff { added: OcrBox[]; removed: OcrBox[] }

// Identity = text + position bucket (8px) so small OCR jitter doesn't churn.
const boxKey = (b: OcrBox) => `${Math.round(b.x1 / 8)}:${Math.round(b.y1 / 8)}:${b.text}`;

export function diffBoxes(prev: OcrBox[], cur: OcrBox[]): BoxDiff {
  const nonEmpty = (bs: OcrBox[]) => bs.filter((b) => b.text.trim().length > 0);
  const p = nonEmpty(prev), c = nonEmpty(cur);
  const pk = new Set(p.map(boxKey));
  const ck = new Set(c.map(boxKey));
  return {
    added: c.filter((b) => !pk.has(boxKey(b))),
    removed: p.filter((b) => !ck.has(boxKey(b))),
  };
}
