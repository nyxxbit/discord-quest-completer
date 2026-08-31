param(
    [ValidateSet('VerifyTarget', 'IsOrionDist', 'StopDiscordUpdaters')][string]$Action = 'VerifyTarget',
    [string]$AppAsar,
    [string]$VencordRoot
)

$ErrorActionPreference = 'Stop'

function Test-IsUnderRoot([string]$Path, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
    try {
        $candidate = [IO.Path]::GetFullPath($Path)
        $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
        return $candidate.Equals((Join-Path $fullRoot 'Update.exe'), [StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

try {
    if ($Action -eq 'StopDiscordUpdaters') {
        $roots = @('Discord', 'DiscordCanary', 'DiscordPTB') | ForEach-Object { Join-Path $env:LOCALAPPDATA $_ }
        $deadline = (Get-Date).AddSeconds(15)
        do {
            $updaters = @(Get-Process Update -ErrorAction SilentlyContinue | Where-Object {
                $path = $null
                try { $path = $_.Path } catch {}
                $matched = $false
                foreach ($root in $roots) {
                    if (Test-IsUnderRoot -Path $path -Root $root) { $matched = $true; break }
                }
                $matched
            })
            if ($updaters.Count -eq 0) { exit 0 }
            $updaters | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)

        $remaining = @(Get-Process Update -ErrorAction SilentlyContinue | Where-Object {
            $path = $null
            try { $path = $_.Path } catch {}
            foreach ($root in $roots) {
                if (Test-IsUnderRoot -Path $path -Root $root) { return $true }
            }
            return $false
        })
        if ($remaining.Count -eq 0) { exit 0 }
        exit 1
    }

    if ($Action -eq 'IsOrionDist') {
        if ([string]::IsNullOrWhiteSpace($VencordRoot)) { exit 1 }
        $dist = Join-Path $VencordRoot 'dist'
        foreach ($name in @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')) {
            if (-not (Test-Path -LiteralPath (Join-Path $dist $name) -PathType Leaf)) { exit 1 }
        }
        $patcher = Join-Path $dist 'patcher.js'
        $renderer = Join-Path $dist 'renderer.js'
        $isStandaloneFrozen = (Select-String -LiteralPath $patcher -Pattern 'Standalone: true' -SimpleMatch -Quiet) -and
            (Select-String -LiteralPath $patcher -Pattern 'Updater Disabled: true' -SimpleMatch -Quiet)
        $hasOrion = Select-String -LiteralPath $renderer -Pattern 'OrionQuests' -SimpleMatch -Quiet
        if ($isStandaloneFrozen -and $hasOrion) { exit 0 }
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($AppAsar) -or [string]::IsNullOrWhiteSpace($VencordRoot)) { exit 1 }
    if (-not (Test-Path -LiteralPath $AppAsar -PathType Leaf)) { exit 1 }
    $text = [IO.File]::ReadAllText($AppAsar)
    $expected = [IO.Path]::GetFullPath((Join-Path $VencordRoot 'dist\patcher.js'))
    # Vencord Installer JSON-marshals the require() path inside app.asar. Match the
    # complete quoted path so another checkout whose path merely shares our prefix
    # cannot be mistaken for the shared %APPDATA%\Vencord build.
    $serializedExpected = '"' + $expected.Replace('\', '\\') + '"'
    if ($text.IndexOf($serializedExpected, [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 0 }
} catch {}

exit 1
