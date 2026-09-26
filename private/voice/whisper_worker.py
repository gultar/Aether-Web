import json
import os
import sys
from pathlib import Path

MODEL_PATH = os.environ.get(
    "BROWSER_OS_WHISPER_MODEL",
    str(Path(__file__).resolve().parents[2] / "models" / "faster-whisper-small.en"),
)


def send(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise RuntimeError(
            "faster-whisper is not installed in this Python environment. "
            "Install it with: python -m pip install faster-whisper"
        ) from exc

    model_path = Path(MODEL_PATH)
    if not model_path.exists():
        raise FileNotFoundError(f"Whisper model folder not found: {model_path}")

    # Keep dictation off the GPU by default. On low-VRAM systems Chromium and
    # the local LLM may already use the GPU; loading Whisper there can stall
    # the browser tab. Set BROWSER_OS_WHISPER_DEVICE=cuda explicitly if wanted.
    device = os.environ.get("BROWSER_OS_WHISPER_DEVICE", "cpu").strip().lower()
    if device == "cuda":
        model = WhisperModel(str(model_path), device="cuda", compute_type="int8_float16")
        return model, "cuda:int8_float16"
    threads = max(1, int(os.environ.get("BROWSER_OS_WHISPER_CPU_THREADS", "4")))
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=threads)
    return model, f"cpu:int8:{threads}threads"


def transcribe(model, audio_path):
    segments, info = model.transcribe(
        audio_path,
        beam_size=1,
        language="en",
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join((segment.text or "").strip() for segment in segments).strip()
    return text, info


def main():
    try:
        model, backend = load_model()
        send({"event": "ready", "ok": True, "model": MODEL_PATH, "backend": backend})
    except Exception as exc:
        send({"event": "ready", "ok": False, "error": str(exc), "model": MODEL_PATH})
        return 1

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            req = json.loads(raw)
            request_id = req.get("id")
            audio_path = str(req.get("path") or "")
            if not audio_path or not Path(audio_path).exists():
                raise FileNotFoundError(f"Audio clip not found: {audio_path}")
            text, info = transcribe(model, audio_path)
            send({
                "id": request_id,
                "ok": True,
                "text": text,
                "language": getattr(info, "language", "en"),
                "language_probability": getattr(info, "language_probability", None),
            })
        except Exception as exc:
            send({"id": request_id, "ok": False, "error": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
