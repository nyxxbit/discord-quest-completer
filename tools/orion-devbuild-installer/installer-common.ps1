# Shared Windows installer helpers for install/update/uninstall.
# Keep Discord discovery and process handling in one place so the three entry
# points cannot silently disagree about Stable / Canary / PTB behavior.

$script:DiscordFlavorInfo = [ordered]@{
    stable = [pscustomobject]@{ Branch = 'stable'; Directory = 'Discord';       Process = 'Discord' }
    canary = [pscustomobject]@{ Branch = 'canary'; Directory = 'DiscordCanary'; Process = 'DiscordCanary' }
    ptb    = [pscustomobject]@{ Branch = 'ptb';    Directory = 'DiscordPTB';    Process = 'DiscordPTB' }
}
$script:VencordDesktopRuntimeFiles = @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')
$script:VencordRevisionFiles = @('patcher.js', 'preload.js', 'renderer.js')

function Get-DiscordFlavorInfo {
    param([Parameter(Mandatory)][string]$Branch)
    $key = $Branch.ToLowerInvariant()
    if (-not $script:DiscordFlavorInfo.Contains($key)) { throw "Unsupported Discord branch '$Branch'. Expected stable, canary, or ptb." }
    return $script:DiscordFlavorInfo[$key]
}

function Get-DiscordRoot {
    param(
        [Parameter(Mandatory)][string]$Branch,
        [string]$LocalAppData = $env:LOCALAPPDATA
    )
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) { throw 'LOCALAPPDATA is empty; cannot locate Discord.' }
    $info = Get-DiscordFlavorInfo -Branch $Branch
    return Join-Path $LocalAppData $info.Directory
}

function Select-VencordDiscordResourcesPath {
    param([Parameter(Mandatory)][string]$DiscordRoot)

    # Match Vencord Installer's Windows ParseDiscord rule: among valid app-* directories,
    # keep the lexicographically greatest <app>/resources/app path. Do not substitute an
    # mtime heuristic here; verification must inspect the same target the installer chose.
    $bestKey = $null
    $bestResources = $null
    Get-ChildItem -LiteralPath $DiscordRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        if (-not $_.Name.StartsWith('app-', [StringComparison]::Ordinal)) { return }
        $resources = Join-Path $_.FullName 'resources'
        if (-not (Test-Path -LiteralPath $resources -PathType Container)) { return }
        $key = Join-Path $resources 'app'
        if ($null -eq $bestKey -or [string]::CompareOrdinal($key, $bestKey) -gt 0) {
            $bestKey = $key
            $bestResources = $resources
        }
    }
    return $bestResources
}

function Test-VencordDistComplete {
    param([Parameter(Mandatory)][string]$DistPath)
    foreach ($name in $script:VencordDesktopRuntimeFiles) {
        $path = Join-Path $DistPath $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        try { if ((Get-Item -LiteralPath $path -ErrorAction Stop).Length -le 0) { return $false } }
        catch { return $false }
    }
    return $true
}

function Get-VencordDistRevision {
    param([Parameter(Mandatory)][string]$DistPath)

    $revisions = @()
    foreach ($name in $script:VencordRevisionFiles) {
        $path = Join-Path $DistPath $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        try {
            $line = Select-String -LiteralPath $path -Pattern '^// Vencord ([0-9a-fA-F]+)$' | Select-Object -First 1
            if (-not $line -or $line.Matches.Count -eq 0) { return $null }
            $revisions += $line.Matches[0].Groups[1].Value.ToLowerInvariant()
        } catch {
            return $null
        }
    }

    $unique = @($revisions | Select-Object -Unique)
    if ($unique.Count -ne 1) { return $null }
    return $unique[0]
}

function Test-OrionVencordDistSemantic {
    param(
        [Parameter(Mandatory)][string]$DistPath,
        [string]$RequiredMarker = 'OrionQuests'
    )

    if (-not (Test-VencordDistComplete -DistPath $DistPath)) { return $false }
    try {
        if (-not (Select-String -LiteralPath (Join-Path $DistPath 'renderer.js') -Pattern $RequiredMarker -SimpleMatch -Quiet)) { return $false }
    } catch {
        return $false
    }
    return -not [string]::IsNullOrWhiteSpace((Get-VencordDistRevision -DistPath $DistPath))
}

function Get-OrionVencordHealthStampPath {
    param([Parameter(Mandatory)][string]$InstallDir)
    return Join-Path $InstallDir '.orion-dist-health.sha256'
}

function Get-VencordDistHashLines {
    param([Parameter(Mandatory)][string]$DistPath)

    foreach ($name in $script:VencordDesktopRuntimeFiles) {
        $path = Join-Path $DistPath $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "runtime file '$name' is missing" }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        "$name=$hash"
    }
}

function Write-OrionVencordHealthStamp {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)][string]$DistPath
    )

    $stamp = Get-OrionVencordHealthStampPath -InstallDir $InstallDir
    $temporary = "$stamp.new"
    $replacementBackup = "$stamp.replace-" + [guid]::NewGuid().ToString('N')
    $lines = [string[]]@(Get-VencordDistHashLines -DistPath $DistPath)
    if ($lines.Count -ne $script:VencordDesktopRuntimeFiles.Count) { throw 'could not hash the complete Vencord runtime' }

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllLines($temporary, $lines, $utf8NoBom)
        if (Test-Path -LiteralPath $stamp -PathType Leaf) {
            # Windows PowerShell 5.1 / .NET Framework can reject a null backup path
            # for File.Replace. Use a same-directory disposable backup instead.
            [IO.File]::Replace($temporary, $stamp, $replacementBackup)
        } else {
            [IO.File]::Move($temporary, $stamp)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $replacementBackup -PathType Leaf) { Remove-Item -LiteralPath $replacementBackup -Force -ErrorAction SilentlyContinue }
    }
}

function Test-OrionVencordDistHealthy {
    param(
        [Parameter(Mandatory)][string]$DistPath,
        [string]$RequiredMarker = 'OrionQuests',
        [Parameter(Mandatory)][string]$HealthStampPath
    )

    if (-not (Test-OrionVencordDistSemantic -DistPath $DistPath -RequiredMarker $RequiredMarker)) { return $false }
    if (-not (Test-Path -LiteralPath $HealthStampPath -PathType Leaf)) { return $false }

    try {
        $expected = [string[]]@(Get-Content -LiteralPath $HealthStampPath -ErrorAction Stop | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $actual = [string[]]@(Get-VencordDistHashLines -DistPath $DistPath)
        if ($expected.Count -ne $actual.Count) { return $false }
        for ($i = 0; $i -lt $actual.Count; $i++) {
            if (-not $expected[$i].Equals($actual[$i], [StringComparison]::OrdinalIgnoreCase)) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

function Get-InstalledDiscordFlavors {
    param([string]$LocalAppData = $env:LOCALAPPDATA)

    # Orion must be able to reopen a selected target after patching it. A stale
    # app-* directory without Squirrel's Update.exe is not a usable install for
    # our lifecycle even though Vencord Installer can still parse the directory.
    foreach ($branch in $script:DiscordFlavorInfo.Keys) {
        $root = Get-DiscordRoot -Branch $branch -LocalAppData $LocalAppData
        $update = Join-Path $root 'Update.exe'
        if ((Test-Path -LiteralPath $update -PathType Leaf) -and (Select-VencordDiscordResourcesPath -DiscordRoot $root)) { $branch }
    }
}

function Get-RunningDiscordFlavors {
    foreach ($branch in $script:DiscordFlavorInfo.Keys) {
        $info = Get-DiscordFlavorInfo -Branch $branch
        if (Get-Process -Name $info.Process -ErrorAction SilentlyContinue | Select-Object -First 1) { $branch }
    }
}

function Resolve-DiscordFlavor {
    param(
        [string[]]$Installed,
        [string[]]$Running,
        [string]$PreferredBranch
    )

    $installedSet = @($Installed | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique)
    $runningSet = @($Running | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Where-Object { $_ -in $installedSet } | Select-Object -Unique)

    if (-not [string]::IsNullOrWhiteSpace($PreferredBranch)) {
        $preferred = (Get-DiscordFlavorInfo -Branch $PreferredBranch).Branch
        if ($preferred -notin $installedSet) { throw "Discord $preferred is not installed or is not launchable." }
        return $preferred
    }

    if ($runningSet.Count -eq 1) { return $runningSet[0] }
    if ($runningSet.Count -gt 1) { throw "More than one Discord flavor is running: $($runningSet -join ', ')." }
    if ($installedSet.Count -eq 1) { return $installedSet[0] }
    if ($installedSet.Count -eq 0) { throw 'No supported launchable Discord desktop install was found.' }
    throw "More than one Discord flavor is installed and none is running: $($installedSet -join ', ')."
}

function Get-DiscordReopenSet {
    param(
        [string[]]$RunningBefore,
        [Parameter(Mandatory)][ValidateSet('stable', 'canary', 'ptb')][string]$TargetBranch
    )

    $result = @()
    foreach ($branch in @($RunningBefore) + @($TargetBranch)) {
        if ([string]::IsNullOrWhiteSpace($branch)) { continue }
        $normalized = (Get-DiscordFlavorInfo -Branch $branch).Branch
        if ($normalized -notin $result) { $result += $normalized }
    }
    return $result
}

function Test-IsDiscordUpdaterPath {
    param(
        [string]$Path,
        [string[]]$DiscordRoots
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try { $candidate = [IO.Path]::GetFullPath($Path) } catch { return $false }

    foreach ($root in $DiscordRoots) {
        if ([string]::IsNullOrWhiteSpace($root)) { continue }
        try { $fullRoot = [IO.Path]::GetFullPath($root).TrimEnd('\', '/') } catch { continue }
        if ($candidate.Equals((Join-Path $fullRoot 'Update.exe'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
        $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
        if ($candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Test-AppAsarPointsToPatcher {
    param(
        [Parameter(Mandatory)][string]$AppAsar,
        [Parameter(Mandatory)][string]$PatcherPath
    )

    try {
        if (-not (Test-Path -LiteralPath $AppAsar -PathType Leaf)) { return $false }
        $text = [IO.File]::ReadAllText($AppAsar)
        $expected = [IO.Path]::GetFullPath($PatcherPath)
        $serializedExpected = '"' + $expected.Replace('\', '\\') + '"'
        return $text.IndexOf($serializedExpected, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } catch {
        return $false
    }
}

function Restore-VencordAppAsar {
    param(
        [Parameter(Mandatory)][string]$AppAsar,
        [Parameter(Mandatory)][string]$PatcherPath
    )

    $resources = Split-Path -Parent $AppAsar
    $backupAsar = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $backupAsar -PathType Leaf)) { return $false }
    try { if ((Get-Item -LiteralPath $backupAsar -ErrorAction Stop).Length -le 0) { return $false } }
    catch { return $false }
    if (Test-AppAsarPointsToPatcher -AppAsar $backupAsar -PatcherPath $PatcherPath) { return $false }

    $hadCurrent = Test-Path -LiteralPath $AppAsar -PathType Leaf
    $temporaryAsar = Join-Path $resources ("app.asar.orion-rollback-" + [guid]::NewGuid().ToString('N'))
    $movedCurrent = $false
    $movedBackup = $false

    try {
        if ($hadCurrent) {
            Rename-Item -LiteralPath $AppAsar -NewName (Split-Path -Leaf $temporaryAsar) -ErrorAction Stop
            $movedCurrent = $true
        }

        Rename-Item -LiteralPath $backupAsar -NewName 'app.asar' -ErrorAction Stop
        $movedBackup = $true

        $restored = (Test-Path -LiteralPath $AppAsar -PathType Leaf) -and
            ((Get-Item -LiteralPath $AppAsar -ErrorAction Stop).Length -gt 0) -and
            -not (Test-AppAsarPointsToPatcher -AppAsar $AppAsar -PatcherPath $PatcherPath)
        if (-not $restored) { throw 'restored app.asar did not verify' }

        if ($movedCurrent -and (Test-Path -LiteralPath $temporaryAsar -PathType Leaf)) {
            Remove-Item -LiteralPath $temporaryAsar -Force -ErrorAction SilentlyContinue
        }
        return $true
    } catch {
        if ($movedBackup -and (Test-Path -LiteralPath $AppAsar -PathType Leaf) -and
            -not (Test-Path -LiteralPath $backupAsar -PathType Leaf)) {
            try { Rename-Item -LiteralPath $AppAsar -NewName '_app.asar' -ErrorAction Stop } catch {}
        }
        if ($movedCurrent -and (Test-Path -LiteralPath $temporaryAsar -PathType Leaf) -and
            -not (Test-Path -LiteralPath $AppAsar -PathType Leaf)) {
            try { Rename-Item -LiteralPath $temporaryAsar -NewName 'app.asar' -ErrorAction Stop } catch {}
        }
        return $false
    }
}

function Get-DiscordUpdaterProcesses {
    $roots = @($script:DiscordFlavorInfo.Keys | ForEach-Object { Get-DiscordRoot -Branch $_ })
    Get-Process Update -ErrorAction SilentlyContinue | ForEach-Object {
        $path = $null
        try { $path = $_.Path } catch {}
        if (Test-IsDiscordUpdaterPath -Path $path -DiscordRoots $roots) { $_ }
    }
}

function Stop-DiscordProcesses {
    Get-Process Discord, DiscordCanary, DiscordPTB, DiscordSystemHelper -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Get-DiscordUpdaterProcesses | Stop-Process -Force -ErrorAction SilentlyContinue

    $deadline = (Get-Date).AddSeconds(15)
    do {
        $remainingClients = @(Get-Process Discord, DiscordCanary, DiscordPTB, DiscordSystemHelper -ErrorAction SilentlyContinue)
        $remainingUpdaters = @(Get-DiscordUpdaterProcesses)
        if ($remainingClients.Count -eq 0 -and $remainingUpdaters.Count -eq 0) { return }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Milliseconds 500
    } while ($true)

    $remaining = @($remainingClients | ForEach-Object { $_.ProcessName }) + @($remainingUpdaters | ForEach-Object { $_.ProcessName })
    throw "Discord did not fully exit within 15 seconds. Still running: $($remaining -join ', '). Close it manually and retry."
}

function Start-DiscordFlavors {
    param(
        [string[]]$Branches,
        [string]$LocalAppData = $env:LOCALAPPDATA
    )

    $requested = @($Branches | Where-Object { $_ } | ForEach-Object { (Get-DiscordFlavorInfo -Branch $_).Branch } | Select-Object -Unique)
    $failed = @()

    foreach ($branch in $requested) {
        $info = Get-DiscordFlavorInfo -Branch $branch
        $update = Join-Path (Get-DiscordRoot -Branch $branch -LocalAppData $LocalAppData) 'Update.exe'
        if (-not (Test-Path -LiteralPath $update -PathType Leaf)) {
            $failed += $branch
            continue
        }
        try {
            Start-Process $update -ArgumentList '--processStart', "$($info.Process).exe" -ErrorAction Stop
        } catch {
            $failed += $branch
        }
    }

    $pending = @($requested | Where-Object { $_ -notin $failed })
    $deadline = (Get-Date).AddSeconds(20)
    while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
        $next = @()
        foreach ($branch in $pending) {
            $info = Get-DiscordFlavorInfo -Branch $branch
            if (-not (Get-Process -Name $info.Process -ErrorAction SilentlyContinue | Select-Object -First 1)) {
                $next += $branch
            }
        }
        $pending = @($next)
        if ($pending.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    }

    $failed += $pending
    return @($failed | Select-Object -Unique)
}

function Get-PnpmInvocation {
    param([Parameter(Mandatory)][string]$PackageJsonPath)

    if (-not (Test-Path -LiteralPath $PackageJsonPath -PathType Leaf)) { throw "package.json not found at $PackageJsonPath" }
    $package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json
    $spec = [string]$package.packageManager
    if ($spec -notmatch '^pnpm@([^+\s]+)') { throw "Vencord package.json has no supported pnpm packageManager entry (got '$spec')." }
    $version = $Matches[1]

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        return [pscustomobject]@{ Command = 'corepack'; Arguments = @('pnpm'); Version = $version }
    }

    if (Get-Command npx -ErrorAction SilentlyContinue) {
        return [pscustomobject]@{ Command = 'npx'; Arguments = @('--yes', "pnpm@$version"); Version = $version }
    }

    throw 'Neither corepack nor npx is available. Reinstall a normal Node.js distribution and re-run.'
}

function Invoke-Pnpm {
    param(
        [Parameter(Mandatory)]$Invocation,
        [string[]]$Arguments
    )
    $all = @($Invocation.Arguments) + @($Arguments)
    & $Invocation.Command @all
}

function Invoke-VencordBuildTransactional {
    param(
        [Parameter(Mandatory)][string]$InstallDir,
        [Parameter(Mandatory)]$Invocation,
        [string]$RequiredMarker = 'OrionQuests'
    )

    $dist = Join-Path $InstallDir 'dist'
    $healthStamp = Get-OrionVencordHealthStampPath -InstallDir $InstallDir
    $snapshot = Join-Path ([IO.Path]::GetTempPath()) ("orion-vencord-dist-" + [guid]::NewGuid().ToString('N'))
    $hadKnownGood = Test-OrionVencordDistHealthy -DistPath $dist -RequiredMarker $RequiredMarker -HealthStampPath $healthStamp

    if ($hadKnownGood) {
        New-Item -ItemType Directory -Force -Path $snapshot | Out-Null
        Copy-Item (Join-Path $dist '*') $snapshot -Recurse -Force -ErrorAction Stop
    }

    $buildCode = 1
    $buildException = $null
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $global:LASTEXITCODE = 0
        try { Invoke-Pnpm -Invocation $Invocation -Arguments @('run', 'build') }
        catch { $buildException = $_.Exception.Message }
        $buildCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }

    $semantic = Test-OrionVencordDistSemantic -DistPath $dist -RequiredMarker $RequiredMarker
    if (-not $buildException -and $buildCode -eq 0 -and $semantic) {
        try {
            Write-OrionVencordHealthStamp -InstallDir $InstallDir -DistPath $dist
            if (Test-OrionVencordDistHealthy -DistPath $dist -RequiredMarker $RequiredMarker -HealthStampPath $healthStamp) {
                Remove-Item -LiteralPath $snapshot -Recurse -Force -ErrorAction SilentlyContinue
                return
            }
            $buildException = 'the Vencord runtime health stamp did not verify after it was written'
        } catch {
            $buildException = "could not persist the Vencord runtime health stamp: $($_.Exception.Message)"
        }
    }

    $restoreOk = $true
    try {
        if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction Stop }
        if ($hadKnownGood) {
            New-Item -ItemType Directory -Force -Path $dist | Out-Null
            Copy-Item (Join-Path $snapshot '*') $dist -Recurse -Force -ErrorAction Stop
            $restoreOk = Test-OrionVencordDistHealthy -DistPath $dist -RequiredMarker $RequiredMarker -HealthStampPath $healthStamp
        } else {
            Remove-Item -LiteralPath $healthStamp -Force -ErrorAction SilentlyContinue
        }
    } catch {
        $restoreOk = $false
    }

    if (-not $restoreOk) {
        if ($hadKnownGood -and (Test-Path -LiteralPath $snapshot -PathType Container)) {
            throw "Vencord build failed and the previous stamped healthy dist could not be restored automatically. A recovery snapshot was kept at $snapshot. Leave Discord open if it is still running; before the next restart, run the official Vencord installer and choose Repair."
        }
        throw 'Vencord build failed and the partial dist could not be cleaned up. No stamped healthy Orion dist existed to snapshot. Leave Discord open if it is still running; before the next restart, run the official Vencord installer and choose Repair.'
    }

    Remove-Item -LiteralPath $snapshot -Recurse -Force -ErrorAction SilentlyContinue
    $recovery = if ($hadKnownGood) { 'The previous stamped healthy Orion dist was restored.' } else { 'The partial build dist was removed; no unverified pre-existing dist was used as rollback.' }
    if ($buildException) { throw "Vencord build failed: $buildException $recovery" }
    if ($buildCode -ne 0) { throw "Vencord build failed (exit code $buildCode). $recovery" }
    throw "Vencord build output failed semantic verification: it must contain the four Discord runtime files, the $RequiredMarker plugin, and one consistent Vencord revision across patcher/preload/renderer. $recovery"
}
