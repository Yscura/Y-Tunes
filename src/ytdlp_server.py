"""Keeps yt-dlp loaded so each lookup skips its startup, which takes seconds on a Raspberry Pi.

Usage: python3 ytdlp_server.py [path to the yt-dlp zipapp]
Reads one JSON request per line on stdin:   {"id": 1, "url": "...", "options": {yt-dlp params}}
Writes one JSON response per line on stdout: {"id": 1, "info": {...}, "warnings": [...]}
                                         or {"id": 1, "error": "...", "warnings": [...]}
"""
import json
import sys
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor

# The bundled yt-dlp is a zipapp, which Python can import from directly.
if len(sys.argv) > 1 and zipfile.is_zipfile(sys.argv[1]):
    sys.path.insert(0, sys.argv[1])

import yt_dlp  # noqa: E402

# Responses own stdout; anything yt-dlp prints goes to stderr instead.
responses = sys.stdout
sys.stdout = sys.stderr
write_lock = threading.Lock()


class Logger:
    def __init__(self):
        self.messages = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.messages.append(msg)

    def error(self, msg):
        self.messages.append(msg)


def respond(payload):
    line = json.dumps(payload)
    with write_lock:
        responses.write(line + "\n")
        responses.flush()


def handle(request):
    logger = Logger()
    options = {**request.get("options", {}), "quiet": True, "noprogress": True, "logger": logger}
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(request["url"], download=False)
            respond({"id": request["id"], "info": ydl.sanitize_info(info), "warnings": logger.messages})
    except Exception as err:  # report every failure to the caller instead of dying
        respond({"id": request["id"], "error": str(err), "warnings": logger.messages})


def main():
    with ThreadPoolExecutor(max_workers=4) as pool:
        respond({"ready": True, "version": yt_dlp.version.__version__})
        for line in sys.stdin:
            if line.strip():
                pool.submit(handle, json.loads(line))


main()
