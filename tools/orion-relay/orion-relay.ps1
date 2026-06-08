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
    $ctx.Response.Headers['Access-Control-Allow-Origin'] = '*'
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
        try {
            $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
            $raw = $reader.ReadToEnd()
            $reader.Dispose()
            $payload = $raw | ConvertFrom-Json

            $upstreamUri = [System.Uri]::new($payload.url)
            if ($upstreamUri.Host -notmatch $allowedHostPattern) {
                Write-Response $ctx 403 "{`"ok`":false,`"status`":0,`"body`":`"host not allowed: $($upstreamUri.Host)`"}"
                continue
            }

            # Build the upstream request via HttpWebRequest so we can set arbitrary headers
            # (Invoke-WebRequest on PS 5.1 is finicky with custom X-* headers + Referer).
            $upstream = [System.Net.HttpWebRequest]::Create($upstreamUri)
            $upstream.Method = 'POST'
            $upstream.ContentType = 'application/json'
            $upstream.UserAgent = 'OrionRelay/1.0'
            $upstream.AllowAutoRedirect = $true
            $upstream.Timeout = 20000

            foreach ($pair in $payload.headers.PSObject.Properties) {
                $name = $pair.Name
                $value = [string]$pair.Value
                switch ($name.ToLowerInvariant()) {
                    'content-type'  { $upstream.ContentType = $value }
                    'user-agent'    { $upstream.UserAgent = $value }
                    'referer'       { $upstream.Referer = $value }
                    'accept'        { $upstream.Accept = $value }
                    'host'          { } # skip — derived from URL
                    default         { $upstream.Headers[$name] = $value }
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
            Write-Response $ctx 200 $result

            $host = $upstreamUri.Host
            Write-Host "[$(Get-Date -Format HH:mm:ss)] POST $($upstreamUri.PathAndQuery) -> $statusCode ($host)"
        } catch {
            $err = $_.Exception.Message -replace '"', "'"
            $errJson = "{`"ok`":false,`"status`":0,`"body`":`"relay error: $err`"}"
            Write-Response $ctx 500 $errJson
            Write-Host "[$(Get-Date -Format HH:mm:ss)] relay error: $err" -ForegroundColor Red
        }
        continue
    }

    Write-Response $ctx 404 '{"ok":false,"status":404,"body":"unknown endpoint"}'
}

$listener.Stop()
