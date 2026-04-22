#!/usr/bin/env python3
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, HTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    serve_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    handler = partial(NoCacheHandler, directory=serve_dir)
    server = HTTPServer(("0.0.0.0", port), handler)
    print(f"serving {serve_dir} on :{port} (no-cache)", flush=True)
    server.serve_forever()
