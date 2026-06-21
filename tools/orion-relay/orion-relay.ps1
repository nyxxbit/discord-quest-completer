# Orion Relay — tiny localhost HTTP relay for the userscript ACHIEVEMENT bypass.
#
# Discord's renderer CSP allows connect-src to http://127.0.0.1:* but blocks
# *.discordsays.com directly. This script listens on 127.0.0.1:43210 and forwards
# POSTs from the userscript to the activity backend, bypassing CSP without
# requiring Vencord / BetterDiscord / any client mod.
#
# Run by double-clicking start-relay.cmd. Leave the window open while the
# userscript runs. Close it (Ctrl+C or X) when done.

$ErrorActionPreference = 'Continue'
$port = 43210
$prefix = "http://127.0.0.1:$port/"

# allowed upstream hosts — we only forward to discordsays activity backends
$allowedHostPattern = '^[0-9]+\.discordsays\.com$'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Host "[Orion Relay] Failed to bind $prefix : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Another instance may be running, or the port is taken. Close it and retry."
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Orion Relay listening on $prefix" -ForegroundColor Cyan
Write-Host " Paste the userscript in Discord DevTools." -ForegroundColor Cyan
Write-Host " Keep this window open. Ctrl+C to stop." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

function Write-Response {
    param($ctx, [int]$status, [string]$body, [string]$contentType = 'application/json')
    $ctx.Response.StatusCode = $status
    # Reflect the CORS origin only for Discord (computed per-request). Other sites then
    # can't read our responses, so a random open browser tab can't drive the relay.
    # Non-browser callers send no Origin and don't need CORS at all.
    if ($script:allowOrigin) { $ctx.Response.Headers['Access-Control-Allow-Origin'] = $script:allowOrigin }
    $ctx.Response.Headers['Access-Control-Allow-Headers'] = 'Content-Type'
    $ctx.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $ctx.Response.Headers['Cache-Control'] = 'no-store'
    $ctx.Response.ContentType = $contentType
    if ($body) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    $ctx.Response.Close()
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch {
        # listener was stopped
        break
    }
    $req = $ctx.Request
    $path = $req.Url.AbsolutePath
    $method = $req.HttpMethod

    # Reflect CORS only back to Discord origins; everything else gets no ACAO header.
    $reqOrigin = $req.Headers['Origin']
    if ($reqOrigin -match '^https://([a-z0-9-]+\.)?discord\.com$') { $script:allowOrigin = $reqOrigin } else { $script:allowOrigin = $null }

    # Reject anything not addressed to our exact loopback host (basic DNS-rebinding guard).
    $hostHeader = $req.Headers['Host']
    if ($hostHeader -and $hostHeader -ne "127.0.0.1:$port") {
        Write-Response $ctx 403 '{"ok":false,"status":0,"body":"bad host"}'
        continue
    }

    # CORS preflight — any path
    if ($method -eq 'OPTIONS') {
        Write-Response $ctx 204 ''
        continue
    }

    # Health probe — userscript uses this to detect the relay
    if ($method -eq 'GET' -and $path -eq '/health') {
        Write-Response $ctx 200 '{"ok":true,"name":"orion-relay","version":"1"}'
        continue
    }

    # Proxy endpoint — POST {url, headers, body} → forward to discordsays
    if ($method -eq 'POST' -and $path -eq '/proxy') {
        $responded = $false
        try {
            # Cap the inbound body. The bypass payloads are tiny; a single-threaded ReadToEnd
            # on a huge body would be a trivial local DoS.
            if ($req.ContentLength64 -gt 65536) {
                Write-Response $ctx 413 '{"ok":false,"status":0,"body":"payload too large"}'
                continue
            }
            $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
            $raw = $reader.ReadToEnd()
            $reader.Dispose()
            $payload = $raw | ConvertFrom-Json

            $upstreamUri = [System.Uri]::new($payload.url)
            # Only allow https to a numeric-id discordsays host, and only the two acf paths
            # the bypass actually uses. Everything else is refused so the relay can't be used
            # as an open proxy into other hosts or paths while it is running.
            if ($upstreamUri.Scheme -ne 'https' -or $upstreamUri.Host -notmatch $allowedHostPattern) {
                Write-Response $ctx 403 "{`"ok`":false,`"status`":0,`"body`":`"host not allowed: $($upstreamUri.Host)`"}"
                continue
            }
            if ($upstreamUri.AbsolutePath -notmatch '^/\.proxy/acf/(authorize|quest/progress)$') {
                Write-Response $ctx 403 "{`"ok`":false,`"status`":0,`"body`":`"path not allowed: $($upstreamUri.AbsolutePath)`"}"
                continue
            }

            # Build the upstream request via HttpWebRequest so we can set arbitrary headers
            # (Invoke-WebRequest on PS 5.1 is finicky with custom X-* headers + Referer).
            $upstream = [System.Net.HttpWebRequest]::Create($upstreamUri)
            $upstream.Method = 'POST'
            $upstream.ContentType = 'application/json'
            $upstream.UserAgent = 'OrionRelay/1.0'
            # No redirect following. The allowed host/path set is fixed, so a redirect could
            # only point somewhere we did not whitelist. Refuse to follow it.
            $upstream.AllowAutoRedirect = $false
            $upstream.Timeout = 20000

            foreach ($pair in $payload.headers.PSObject.Properties) {
                $name = $pair.Name
                $value = [string]$pair.Value
                # Strict allowlist — only the headers the bypass actually needs. Anything else
                # a caller tries to smuggle through (Cookie, X-Forwarded-For, etc.) is dropped.
                switch ($name.ToLowerInvariant()) {
                    'content-type'       { $upstream.ContentType = $value }
                    'user-agent'         { $upstream.UserAgent = $value }
                    'referer'            { $upstream.Referer = $value }
                    'accept'             { $upstream.Accept = $value }
                    'x-auth-token'       { $upstream.Headers['X-Auth-Token'] = $value }
                    'x-discord-quest-id' { $upstream.Headers['X-Discord-Quest-ID'] = $value }
                    default              { } # drop
                }
            }

            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload.body)
            $upstream.ContentLength = $bodyBytes.Length
            $reqStream = $upstream.GetRequestStream()
            $reqStream.Write($bodyBytes, 0, $bodyBytes.Length)
            $reqStream.Close()

            try {
                $upstreamRes = $upstream.GetResponse()
                $statusCode = [int]$upstreamRes.StatusCode
                $resReader = New-Object System.IO.StreamReader($upstreamRes.GetResponseStream())
                $resBody = $resReader.ReadToEnd()
                $resReader.Dispose()
                $upstreamRes.Close()
            } catch [System.Net.WebException] {
                $upstreamRes = $_.Exception.Response
                if ($upstreamRes) {
                    $statusCode = [int]$upstreamRes.StatusCode
                    $resReader = New-Object System.IO.StreamReader($upstreamRes.GetResponseStream())
                    $resBody = $resReader.ReadToEnd()
                    $resReader.Dispose()
                    $upstreamRes.Close()
                } else {
                    $statusCode = 0
                    $resBody = $_.Exception.Message
                }
            }

            $ok = $statusCode -ge 200 -and $statusCode -lt 300
            $result = @{ ok = $ok; status = $statusCode; body = $resBody } | ConvertTo-Json -Compress

            # Log BEFORE responding so a logging error can't trigger a double-Write-Response
            # in the catch block below. Use $upstreamHost (not $host — $host is a PS automatic variable).
            $upstreamHost = $upstreamUri.Host
            Write-Host "[$(Get-Date -Format HH:mm:ss)] POST $($upstreamUri.PathAndQuery) -> $statusCode ($upstreamHost)"

            Write-Response $ctx 200 $result
            $responded = $true
        } catch {
            $err = $_.Exception.Message -replace '"', "'"
            Write-Host "[$(Get-Date -Format HH:mm:ss)] relay error: $err" -ForegroundColor Red
            if (-not $responded) {
                $errJson = "{`"ok`":false,`"status`":0,`"body`":`"relay error: $err`"}"
                try { Write-Response $ctx 500 $errJson } catch { }
            }
        }
        continue
    }

    Write-Response $ctx 404 '{"ok":false,"status":404,"body":"unknown endpoint"}'
}

$listener.Stop()
