#!/usr/bin/env python3
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    # Class-level log file so all instances share it
    _log_file = None

    def log_message(self, format, *args):
        """Override to also write access log to file."""
        msg = f"{self.client_address[0]} - [{self.log_date_time_string()}] {format % args}"
        if self._log_file:
            self._log_file.write(msg + "\n")
            self._log_file.flush()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # Required for SharedArrayBuffer (used by multiThreaded wasm builds
        # so each guest thread can run on its own Web Worker).
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def do_POST(self):
        # POST /save writes the body to diablo_save.boxedstate in the serve
        # directory. Used by the shell's "save to disk" helper so the file
        # auto-loads next reload without the user downloading + copying.
        if self.path == "/save":
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length) if length else b""
            target = os.path.join(self.directory, "diablo_save.boxedstate")
            try:
                with open(target + ".tmp", "wb") as f:
                    f.write(data)
                os.replace(target + ".tmp", target)
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"OK " + str(len(data)).encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            return
        self.send_response(404)
        self.end_headers()

    def do_PUT(self):
        # PUT /log prints the body to the server console so the CLI can see
        # what the browser is doing (emulator config, DLL loads, errors).
        if self.path == "/log":
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length) if length else b""
            try:
                text = data.decode("utf-8", errors="replace")
                for line in text.splitlines():
                    print(f"[browser] {line}", flush=True)
                    if self._log_file:
                        self._log_file.write(f"[browser] {line}\n")
                        self._log_file.flush()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"OK")
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
            return
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    serve_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    log_path = os.path.join(serve_dir, "server.log")
    NoCacheHandler._log_file = open(log_path, "a")
    handler = partial(NoCacheHandler, directory=serve_dir)
    server = ThreadingHTTPServer(("0.0.0.0", port), handler)
    print(f"serving {serve_dir} on :{port} (no-cache)", flush=True)
    print(f"log file: {log_path}", flush=True)
    try:
        server.serve_forever()
    finally:
        NoCacheHandler._log_file.close()
