BeforeAll {
    . (Join-Path $PSScriptRoot '..\release-helpers.ps1')

    function New-TempRepo([string] $Path) {
        git init $Path | Out-Null
        git -C $Path -c user.email=t@example.com -c user.name=t commit --allow-empty -m init | Out-Null
        (git -C $Path rev-parse HEAD).Trim()
    }
}

Describe 'Get-PnpmInvocation' {
    It 'uses corepack when it is available' {
        Mock Get-Command { [pscustomobject]@{ Name = 'corepack' } }
        (Get-PnpmInvocation 'pnpm@12.15.0') -join ' ' | Should -Be 'corepack pnpm'
    }

    It 'uses npx --yes when corepack is missing' {
        Mock Get-Command {
            param($Name)
            if ($Name -eq 'corepack') { $null }
            elseif ($Name -eq 'npx') { [pscustomobject]@{ Name = 'npx' } }
            else { $null }
        }
        (Get-PnpmInvocation 'pnpm@12.15.0') -join ' ' | Should -Be 'npx --yes pnpm@12.15.0'
    }

    It 'drops the integrity suffix from packageManager' {
        Mock Get-Command {
            param($Name)
            if ($Name -eq 'npx') { [pscustomobject]@{ Name = 'npx' } }
            else { $null }
        }
        (Get-PnpmInvocation 'pnpm@10.4.1+sha512.abc123') -join ' ' | Should -Be 'npx --yes pnpm@10.4.1'
    }

    It 'rejects a packageManager that is not pnpm' {
        { Get-PnpmInvocation 'yarn@4.0.0' } | Should -Throw
    }
}

Describe 'Assert-VencordRevision' {
    It 'accepts a source checked out at the pinned revision' {
        $sha = New-TempRepo (Join-Path $TestDrive 'ok')
        { Assert-VencordRevision (Join-Path $TestDrive 'ok') $sha } | Should -Not -Throw
    }

    It 'rejects a source at a different revision' {
        New-TempRepo (Join-Path $TestDrive 'stale') | Out-Null
        { Assert-VencordRevision (Join-Path $TestDrive 'stale') ('0' * 40) } | Should -Throw '*pinned revision*'
    }

    It 'rejects a directory that is not a git checkout' {
        $dir = Join-Path $TestDrive 'plain'
        New-Item -ItemType Directory $dir | Out-Null
        { Assert-VencordRevision $dir ('0' * 40) } | Should -Throw '*not a git checkout*'
    }
}

Describe 'Assert-VencordBannerRevision' {
    It 'accepts a banner from the pinned revision' {
        {
            Assert-VencordBannerRevision `
                "// Vencord 383409e`n// Standalone: true`n// Updater Disabled: true" `
                '383409e6a6ec9008ee8a7496500f1e75f17824d1'
        } | Should -Not -Throw
    }

    It 'rejects a stale dist banner' {
        {
            Assert-VencordBannerRevision `
                "// Vencord 90aea0d`n// Standalone: true`n// Updater Disabled: true" `
                '383409e6a6ec9008ee8a7496500f1e75f17824d1'
        } | Should -Throw '*expected tested revision*'
    }

    It 'rejects a banner without a Vencord revision' {
        {
            Assert-VencordBannerRevision `
                "// Standalone: true`n// Updater Disabled: true" `
                '383409e6a6ec9008ee8a7496500f1e75f17824d1'
        } | Should -Throw '*could not read*'
    }
}