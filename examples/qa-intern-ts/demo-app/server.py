#!/usr/bin/env python3
"""Nebula Notes — a tiny notes app with six planted bugs (see BUGS.md).

Standard library only, so it runs in a bare Solari `base` sandbox:

    python3 server.py --port 3000
"""
import argparse
import json
import mimetypes
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATIC = Path(__file__).parent / "static"
PAGES = {"/": "index.html", "/settings": "settings.html", "/about": "about.html"}
HTTP_OK = 200
HTTP_CREATED = 201
HTTP_BAD_REQUEST = 400
HTTP_NOT_FOUND = 404
HTTP_SERVER_ERROR = 500

notes = [
    {"id": 1, "title": "Welcome to Nebula", "body": "Your notes live here."},
    {"id": 2, "title": "Try adding a note", "body": "Then delete this one."},
]
next_id = 3


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.dispatch(self.route_get)

    def do_POST(self):
        self.dispatch(self.route_post)

    def do_DELETE(self):
        self.dispatch(self.route_delete)

    # Any exception becomes a 500 with a traceback in the log — like a real framework.
    def dispatch(self, route):
        try:
            route()
        except Exception:
            traceback.print_exc()
            self.send_json(HTTP_SERVER_ERROR, {"error": "internal server error"})

    def route_get(self):
        if self.path == "/api/notes":
            return self.send_json(HTTP_OK, {"notes": notes})
        if self.path in PAGES:
            return self.send_file(STATIC / PAGES[self.path])
        if self.path.startswith("/static/"):
            return self.send_file(STATIC / self.path[len("/static/"):])
        # B1: the nav links to /changelog, which does not exist.
        return self.send_json(HTTP_NOT_FOUND, {"error": "not found"})

    def route_post(self):
        global next_id
        if self.path != "/api/notes":
            return self.send_json(HTTP_NOT_FOUND, {"error": "not found"})

        payload = json.loads(self.read_body() or "{}")
        title = (payload.get("title") or "").strip()
        if not title:
            return self.send_json(HTTP_BAD_REQUEST, {"error": "title is required"})

        # B4: a legacy "ASCII only" check — any non-ASCII title blows up with a 500.
        title.encode("ascii")

        note = {"id": next_id, "title": title, "body": (payload.get("body") or "").strip()}
        next_id += 1
        notes.append(note)
        self.send_json(HTTP_CREATED, note)

    def route_delete(self):
        prefix = "/api/notes/"
        if not self.path.startswith(prefix):
            return self.send_json(HTTP_NOT_FOUND, {"error": "not found"})

        note_id = int(self.path[len(prefix):])
        before = len(notes)
        notes[:] = [n for n in notes if n["id"] != note_id]
        if len(notes) == before:
            return self.send_json(HTTP_NOT_FOUND, {"error": "no such note"})
        self.send_json(HTTP_OK, {"deleted": note_id})

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length).decode("utf-8")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path):
        if not path.is_file():
            return self.send_json(HTTP_NOT_FOUND, {"error": "not found"})
        body = path.read_bytes()
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTP_OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Nebula Notes listening on http://0.0.0.0:{args.port}", file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
