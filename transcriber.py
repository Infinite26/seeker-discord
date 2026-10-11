#!/usr/bin/env python3
"""Whisper transcription sidecar for the Seeker Discord bot.

HTTP contract:
    GET  /health          -> {"ok": true}
    POST /transcribe      -> body: raw 16kHz mono 16-bit PCM
                            returns {"text": "..."}
Uses the same faster-whisper model + settings as Seeker.
"""
from __future__ import annotations

import io
import json
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from faster_whisper import WhisperModel

MODEL = "small.en"
CPU_THREADS = 8
COMPUTE_TYPE = "int8"

_model = None


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        print("[transcriber] loading faster-whisper small.en ...", flush=True)
        _model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE_TYPE,
                              cpu_threads=CPU_THREADS)
    return _model


def transcribe_pcm(pcm_bytes: bytes) -> str:
    # Expect raw signed 16-bit mono PCM at 16kHz.
    pcm = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
    if pcm.size == 0:
        return ""
    segments, _ = get_model().transcribe(pcm, beam_size=1, language="en",
                                         vad_filter=False)
    return " ".join(seg.text.strip() for seg in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            text = transcribe_pcm(raw)
            body = json.dumps({"text": text}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            print(f"[transcriber] -> {text!r}", flush=True)
        except Exception as exc:
            print(f"[transcriber] error: {exc}", flush=True)
            body = json.dumps({"text": ""}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18771
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[transcriber] listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()