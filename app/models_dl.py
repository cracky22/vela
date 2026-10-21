"""Einmaliger Download der Transkriptions-Laufzeit (Transformers.js + ONNX Runtime Web) und
der Whisper-Modelle auf den eigenen Server.

Warum selbst hosten?
* Datenschutz: Browser laden nichts mehr von Drittanbietern (keine IP-Weitergabe an CDNs).
* Zuverlässigkeit: keine Abhängigkeit von CDN-Verfügbarkeit und keine Lockerung der
  Content-Security-Policy für fremde Skripte.
Das Audio bleibt weiterhin auf dem Gerät des Empfängers – der Server stellt nur die
öffentlichen Modelldateien bereit.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
from pathlib import Path

from . import config

log = logging.getLogger("vela.models")

TRANSFORMERS_VERSION = "4.3.1"
VENDOR_DIR = config.DATA_DIR / "vendor"
MANIFEST = VENDOR_DIR / "manifest.json"
JSDELIVR = "https://cdn.jsdelivr.net/npm"
HF = "https://huggingface.co"
MODELS = {
    "onnx-community/whisper-tiny": "Whisper Tiny (~40 MB, schnell)",
    "onnx-community/whisper-base": "Whisper Base (~80 MB, genauer)",
}
# Transformers.js lädt im Browser per Standard die q8-Variante ("_quantized")
MODEL_ONNX = ("onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx")
ORT_FILES = ("ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm",
             "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm")
UA = {"User-Agent": "Vela-Messenger/1.1 (+self-hosted model download)"}

_lock = threading.Lock()
state: dict = {"running": False, "model": None, "progress": 0.0, "loaded": 0, "total": 0,
               "current": "", "error": None, "finished_at": None}


def _manifest() -> dict:
    try:
        return json.loads(MANIFEST.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _save_manifest(m: dict) -> None:
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(m, indent=2), "utf-8")


def status() -> dict:
    m = _manifest()
    runtime = bool(m.get("runtime")) and (VENDOR_DIR / "transformers.min.js").exists()
    return {
        "runtime": runtime,
        "installed": {k: runtime and k in m.get("models", {}) for k in MODELS},
        "ort_prefix": m.get("runtime", {}).get("ort_prefix"),
        "asyncify": bool(m.get("runtime", {}).get("asyncify")),
        "models": MODELS,
        "state": dict(state),
    }


def _open(url: str, method: str = "GET"):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA, method=method), timeout=60)


def _json(url: str):
    with _open(url) as r:
        return json.loads(r.read().decode("utf-8"))


def _size(url: str) -> int:
    try:
        with _open(url, "HEAD") as r:
            return int(r.headers.get("Content-Length") or 0)
    except Exception:
        return 0


def _download(url: str, dest: Path, optional: bool = False) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        state["loaded"] += dest.stat().st_size
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    state["current"] = dest.name
    try:
        with _open(url) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                state["loaded"] += len(chunk)
                if state["total"]:
                    state["progress"] = min(0.999, state["loaded"] / state["total"])
        tmp.replace(dest)
        return True
    except Exception as e:
        tmp.unlink(missing_ok=True)
        if optional:
            log.info("Optionale Datei nicht verfügbar: %s (%s)", url, e)
            return False
        raise


def _install(model: str) -> None:
    m = _manifest()
    plan: list[tuple[str, Path, bool]] = []

    # 1) Laufzeit: Transformers.js-Bundle + passende ONNX-Runtime-WASM-Dateien
    if not m.get("runtime") or not (VENDOR_DIR / "transformers.min.js").exists():
        state["current"] = "Versionen ermitteln"
        pkg = _json(f"{JSDELIVR}/@huggingface/transformers@{TRANSFORMERS_VERSION}/package.json")
        ort_version = pkg["dependencies"]["onnxruntime-web"]
        plan.append((f"{JSDELIVR}/@huggingface/transformers@{TRANSFORMERS_VERSION}/dist/transformers.min.js",
                     VENDOR_DIR / "transformers.min.js", False))
        for name in ORT_FILES:
            plan.append((f"{JSDELIVR}/onnxruntime-web@{ort_version}/dist/{name}", VENDOR_DIR / "ort" / name,
                         "asyncify" in name))
        m["runtime"] = {"transformers": TRANSFORMERS_VERSION, "ort": ort_version,
                        "ort_prefix": f"{JSDELIVR}/onnxruntime-web@{ort_version}/dist/"}

    # 2) Modell: Konfigurations-/Tokenizer-Dateien + quantisierte ONNX-Gewichte
    if model not in m.get("models", {}):
        state["current"] = "Modelldateien ermitteln"
        info = _json(f"{HF}/api/models/{model}")
        files = [s["rfilename"] for s in info.get("siblings", [])]
        wanted = [f for f in files if "/" not in f and f.endswith((".json", ".txt"))]
        wanted += [f for f in files if f in MODEL_ONNX or any(f.startswith(o + "_data") for o in MODEL_ONNX)]
        missing = [o for o in MODEL_ONNX if o not in files]
        if missing:
            raise RuntimeError(f"Modell {model} enthält nicht die erwarteten Dateien: {missing}")
        for f in wanted:
            plan.append((f"{HF}/{model}/resolve/main/{f}", VENDOR_DIR / "models" / model / f, False))

    state["current"] = "Größe berechnen"
    state["total"] = sum(_size(url) for url, dest, _ in plan if not dest.exists()) + \
        sum(dest.stat().st_size for _, dest, _ in plan if dest.exists())
    for url, dest, optional in plan:
        _download(url, dest, optional)
    m["runtime"]["asyncify"] = (VENDOR_DIR / "ort" / "ort-wasm-simd-threaded.asyncify.wasm").exists()
    m.setdefault("models", {})[model] = {"installed_at": int(time.time())}
    _save_manifest(m)


def install_async(model: str) -> bool:
    """Startet den Download im Hintergrund. False, wenn bereits ein Download läuft."""
    if model not in MODELS:
        raise ValueError("Unbekanntes Modell")
    with _lock:
        if state["running"]:
            return False
        state.update(running=True, model=model, progress=0.0, loaded=0, total=0, current="", error=None)

    def run():
        try:
            _install(model)
            state.update(progress=1.0, current="fertig", finished_at=int(time.time()))
        except Exception as e:  # Netzwerkfehler etc. verständlich an die UI melden
            log.warning("Modell-Download fehlgeschlagen: %s", e)
            state["error"] = f"Download fehlgeschlagen: {e}"
        finally:
            state["running"] = False

    threading.Thread(target=run, name="vela-model-download", daemon=True).start()
    return True


def install_blocking(model: str) -> None:
    """Für `python run.py --setup-transcription` (mit Konsolenausgabe)."""
    if not install_async(model):
        print("Es läuft bereits ein Download.")
    while state["running"]:
        pct = int(state["progress"] * 100)
        print(f"\r  {pct:3d} %  {state['current'][:50]:<50}", end="", flush=True)
        time.sleep(0.5)
    print()
    if state["error"]:
        raise SystemExit(state["error"])
    print(f"  ✓ {MODELS[model]} installiert in {VENDOR_DIR}")
