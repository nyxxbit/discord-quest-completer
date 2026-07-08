# Orion Relay

A tiny localhost HTTP relay that unlocks the `ACHIEVEMENT_IN_ACTIVITY` auto-bypass for the standalone userscript on Discord Desktop &mdash; **no Vencord, no BetterDiscord, no client mod required**.

## Why this exists

Discord's renderer CSP (`connect-src` allowlist) blocks `fetch()` to `*.discordsays.com` from the userscript:

```
Refused to connect to 'https://{appId}.discordsays.com/.proxy/acf/authorize'
because it violates the following Content Security Policy directive: "connect-src 'self' ..."
```

The allowlist **does** include `http://127.0.0.1:*` (Discord uses this for RPC with games). So the userscript can talk to a relay running on `127.0.0.1`, and the relay (running outside the browser sandbox) can talk to `discordsays.com` freely.

That's the entire trick.

## Install / run

### Windows

1. Download `orion-relay.ps1` and `start-relay.cmd` from this folder into the same directory (e.g. `C:\Tools\orion-relay\`).
2. Double-click `start-relay.cmd`. A console window opens:
   ```
   ==========================================
    Orion Relay listening on http://127.0.0.1:43210/
    Paste the userscript in Discord DevTools.
    Keep this window open. Ctrl+C to stop.
   ==========================================
   ```
3. Leave it open. Paste the userscript into Discord's DevTools console as usual. It'll detect the relay automatically.
4. Done. Close the window with Ctrl+C or the X button when you're done.

### Linux / macOS (and from-source)

The relay is a 100-line PowerShell script. PowerShell 7+ runs on Linux/macOS &mdash; install via your package manager, then:

```sh
pwsh ./orion-relay.ps1
```

If you'd rather not install PowerShell, use the bundled Python port. It needs
only the Python 3 standard library &mdash; no `pip install`:

```sh
python3 ./orion-relay.py
```

Same wire protocol, same security posture (loopback-only bind, host allowlist,
path allowlist, header allowlist, no redirect following, 64 KB body cap). Prefer
Node? The wire protocol below is trivial to reimplement.

## Wire protocol

The userscript talks to the relay over plain HTTP. Two endpoints:

### `GET /health`
Probe to confirm the relay is running. Returns 200 with `{"ok":true,"name":"orion-relay","version":"1"}`.

### `POST /proxy`
Forward a request to `*.discordsays.com`. Body:

```json
{
  "url": "https://1495767543946809424.discordsays.com/.proxy/acf/authorize",
  "headers": {
    "Content-Type": "application/json",
    "X-Auth-Token": "",
    "X-Discord-Quest-ID": "1511073863214170153",
    "Referer": "https://1495767543946809424.discordsays.com/?instance_id=..."
  },
  "body": "{\"code\":\"AUTH_CODE_HERE\"}"
}
```

Response:

```json
{ "ok": true, "status": 200, "body": "{\"token\":\"DS_TOKEN\"}" }
```

## Security

- Listens only on `127.0.0.1` &mdash; not reachable from other machines on your network.
- Whitelists upstream hosts to `^[0-9]+\.discordsays\.com$`. Won't forward to arbitrary URLs.
- No credentials are stored or logged.
- The script source is short &mdash; read it before you run it.

That said: any process on your machine can `fetch('http://127.0.0.1:43210/proxy')` while the relay is running. The relay's host restriction limits the damage, but if you're paranoid, stop the relay between sessions.
