#!/usr/bin/env python3
"""Orion Relay — tiny localhost HTTP relay for the userscript ACHIEVEMENT bypass.

Discord's renderer CSP allows connect-src to http://127.0.0.1:* but blocks
*.discordsays.com directly. This listens on 127.0.0.1:43210 and forwards POSTs
from the userscript to the activity backend, bypassing CSP without requiring
Vencord / BetterDiscord / any client mod.

Run:  python3 orion_relay.py    (Ctrl+C to stop)

Python port of orion-relay.ps1 — same wire protocol, same security posture.
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 43210
HOST = "127.0.0.1"

# only forward to discordsays activity backends
ALLOWED_HOST = re.compile(r'^[0-9]+\.discordsays\.com$')
ALLOWED_PATH = re.compile(r'^/\.proxy/acf/(authorize|quest/progress)$')
ALLOWED_ORIGIN = re.compile(r'^https://([a-z0-9-]+\.)?discord\.com$')

# strict header allowlist: incoming name (lowercase) -> upstream name. Anything
# else a caller tries to smuggle (Cookie, X-Forwarded-For, ...) is dropped.
HEADER_ALLOW = {
    'content-type': 'Content-Type',
    'user-agent': 'User-Agent',
    'referer': 'Referer',
    'accept': 'Accept',
    'x-auth-token': 'X-Auth-Token',
    'x-discord-quest-id': 'X-Discord-Quest-ID',
}
MAX_BODY = 65536


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):  # silence default stderr logging
        pass

    def _send(self, status, body='', origin=None, content_type='application/json'):
        data = body.encode('utf-8') if body else b''
        self.send_response(status)
        # Reflect CORS origin only for Discord (computed per-request). Other sites
        # then can't read our responses, so a random open tab can't drive the relay.
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _origin(self):
        o = self.headers.get('Origin')
        return o if o and ALLOWED_ORIGIN.match(o) else None

    def _bad_host(self):
        # Reject anything not addressed to our exact loopback host (DNS-rebinding guard).
        h = self.headers.get('Host')
        return h is not None and h != f"{HOST}:{PORT}"

    def do_OPTIONS(self):
        if self._bad_host():
            return self._send(403, '{"ok":false,"status":0,"body":"bad host"}', self._origin())
        self._send(204, '', self._origin())

    def do_GET(self):
        origin = self._origin()
        if self._bad_host():
            return self._send(403, '{"ok":false,"status":0,"body":"bad host"}', origin)
        if self.path == '/health':
            return self._send(200, '{"ok":true,"name":"orion-relay","version":"1"}', origin)
        self._send(404, '{"ok":false,"status":404,"body":"unknown endpoint"}', origin)

    def do_POST(self):
        origin = self._origin()
        if self._bad_host():
            return self._send(403, '{"ok":false,"status":0,"body":"bad host"}', origin)
        if self.path != '/proxy':
            return self._send(404, '{"ok":false,"status":404,"body":"unknown endpoint"}', origin)

        try:
            length = int(self.headers.get('Content-Length') or 0)
            # Cap inbound body — bypass payloads are tiny; a huge body would be a trivial local DoS.
            if length > MAX_BODY:
                return self._send(413, '{"ok":false,"status":0,"body":"payload too large"}', origin)
            payload = json.loads(self.rfile.read(length).decode('utf-8'))

            parsed = urllib.parse.urlsplit(payload['url'])
            # Only https to a numeric-id discordsays host, and only the two acf paths the
            # bypass uses. Everything else refused so the relay can't be an open proxy.
            if parsed.scheme != 'https' or not ALLOWED_HOST.match(parsed.hostname or ''):
                return self._send(403, json.dumps(
                    {"ok": False, "status": 0, "body": f"host not allowed: {parsed.hostname}"}), origin)
            if not ALLOWED_PATH.match(parsed.path):
                return self._send(403, json.dumps(
                    {"ok": False, "status": 0, "body": f"path not allowed: {parsed.path}"}), origin)

            headers = {'Content-Type': 'application/json', 'User-Agent': 'OrionRelay/1.0'}
            for name, value in (payload.get('headers') or {}).items():
                mapped = HEADER_ALLOW.get(name.lower())
                if mapped:
                    headers[mapped] = str(value)

            body_bytes = str(payload.get('body', '')).encode('utf-8')
            # No redirect following (default for urllib is to follow, so use a no-op handler):
            # the allowed host/path set is fixed, a redirect could only point off-whitelist.
            req = urllib.request.Request(payload['url'], data=body_bytes, headers=headers, method='POST')
            try:
                res = _opener.open(req, timeout=20)
                status = res.status
                res_body = res.read().decode('utf-8', 'replace')
            except urllib.error.HTTPError as e:
                status = e.code
                res_body = e.read().decode('utf-8', 'replace')
            except urllib.error.URLError as e:
                status = 0
                res_body = str(e.reason)

            ok = 200 <= status < 300
            result = json.dumps({"ok": ok, "status": status, "body": res_body})
            print(f"[{datetime.now():%H:%M:%S}] POST {parsed.path} -> {status} ({parsed.hostname})")
            self._send(200, result, origin)
        except Exception as e:
            err = str(e).replace('"', "'")
            print(f"[{datetime.now():%H:%M:%S}] relay error: {err}", file=sys.stderr)
            try:
                self._send(500, json.dumps({"ok": False, "status": 0, "body": f"relay error: {err}"}), origin)
            except Exception:
                pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print(f"[Orion Relay] Failed to bind {HOST}:{PORT} : {e}")
        print("Another instance may be running, or the port is taken. Close it and retry.")
        sys.exit(1)
    bar = "=" * 42
    print(bar)
    print(f" Orion Relay listening on http://{HOST}:{PORT}/")
    print(" Paste the userscript in Discord DevTools.")
    print(" Keep this window open. Ctrl+C to stop.")
    print(bar)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Orion Relay] stopped.")
        server.shutdown()


if __name__ == '__main__':
    main()
