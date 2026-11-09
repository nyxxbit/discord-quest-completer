# Helpers for package-release.ps1. They throw instead of calling Die so Pester can test them.
function Get-PnpmInvocation([string] $PackageManager) {
    $m = [regex]::Match([string]$PackageManager, '^pnpm@(\d+\.\d+\.\d+)')
    if (-not $m.Success) {
        throw "packageManager must specify pnpm@x.y.z, got '$PackageManager'"
    }
    # Node 25 no longer bundles corepack. The version is taken before any integrity suffix.
    if (Get-Command corepack -ErrorAction SilentlyContinue) { return @('corepack', 'pnpm') }
    return @('npx', '--yes', "pnpm@$($m.Groups[1].Value)")
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