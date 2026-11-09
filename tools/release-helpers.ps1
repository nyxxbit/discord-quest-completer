# Helpers for package-release.ps1. They throw instead of calling Die so Pester can test them.
function Get-PnpmInvocation([string] $PackageManager) {
    $m = [regex]::Match([string]$PackageManager, '^pnpm@([^+\s]+)')
    if (-not $m.Success) {
        throw "packageManager must specify pnpm@<version>, got '$PackageManager'"
    }
    $version = $m.Groups[1].Value

    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        return @('corepack', 'pnpm')
    }
    if (Get-Command npx -ErrorAction SilentlyContinue) {
        return @('npx', '--yes', "pnpm@$version")
    }
    throw 'Neither corepack nor npx is available.'
}

function Assert-VencordRevision([string] $SourceRoot, [string] $Ref) {
    $head = git -C $SourceRoot rev-parse HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $head) {
        throw "'$SourceRoot' is not a git checkout; cannot verify the Vencord revision."
    }
    if ($head.Trim() -ne $Ref) {
        throw "bundle source is at $($head.Trim()) but the pinned revision is $Ref."
    }
}

function Assert-VencordBannerRevision([string] $Banner, [string] $ExpectedRef) {
    $m = [regex]::Match($Banner, '(?im)^// Vencord ([a-f0-9]+)\s*$')
    if (-not $m.Success) {
        throw 'could not read the Vencord revision from the bundle dist banner.'
    }
    $bannerHash = $m.Groups[1].Value
    if (-not $ExpectedRef.StartsWith($bannerHash, [StringComparison]::OrdinalIgnoreCase)) {
        throw "bundle dist was built from Vencord commit $bannerHash, but the expected tested revision is $ExpectedRef."
    }
}