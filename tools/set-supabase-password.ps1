# Verify the existing database password, then save both Supabase pooler URLs locally.
# Usage from the repository: powershell -NoProfile -File .\tools\set-supabase-password.ps1
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousProbeUrl = [Environment]::GetEnvironmentVariable('CHATBOT_SUPABASE_PROBE_URL', 'Process')
$secure = Read-Host 'Enter the sylv_project DATABASE password (not your GitHub password; input is hidden)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ([string]::IsNullOrEmpty($password)) { throw 'Password is empty; no files changed.' }
    $encoded = [Uri]::EscapeDataString($password)
    $password = $null
    $connectionBase = 'postgresql://postgres.gmuqwpfllgmvhzhehepp:' + $encoded + '@aws-0-ap-south-1.pooler.supabase.com:'
    $sessionUrl = $connectionBase + '5432/postgres?sslmode=verify-full'
    $transactionUrl = $connectionBase + '6543/postgres?sslmode=verify-full'
    $env:CHATBOT_SUPABASE_PROBE_URL = $sessionUrl
    Push-Location $repoRoot
    try {
        # The password travels only through the child process environment, never command arguments or logs.
        @'
import pg from './packages/database/node_modules/pg/lib/index.js';
import { connectionConfig } from './packages/database/src/client.ts';
const client = new pg.Client({ ...connectionConfig(process.env.CHATBOT_SUPABASE_PROBE_URL), connectionTimeoutMillis: 10000 });
try {
  await client.connect();
  await client.query('select 1 as connection_ok');
  console.log('Verified Supabase database connection with certificate validation.');
} catch {
  console.error('Database connection failed. Check the database password and network; no files changed.');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
'@ | node --input-type=module
        if ($LASTEXITCODE -ne 0) { throw 'Supabase connection check failed; no files changed.' }
    } finally { Pop-Location }

    $values = [ordered]@{
        DATABASE_URL = $transactionUrl
        DATABASE_URL_UNPOOLED = $sessionUrl
        NEXT_PUBLIC_SUPABASE_URL = 'https://gmuqwpfllgmvhzhehepp.supabase.co'
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_qXPpIsUqE7pWJd0cUrSTzw_5W5RIJ9q'
    }
    foreach ($relativePath in @('.env.local', 'apps/dashboard/.env.local')) {
        $path = Join-Path $repoRoot $relativePath
        $lines = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllLines($path) } else { @() }
        $lines = @($lines | Where-Object { $_ -notmatch '^\s*NEON_BRANCH\s*=' })
        foreach ($name in $values.Keys) {
            $found = $false
            $replacement = $name + '=' + $values[$name]
            $lines = @(foreach ($line in $lines) {
                if ($line -match ('^\s*' + [regex]::Escape($name) + '\s*=')) {
                    $found = $true
                    $replacement
                } else { $line }
            })
            if (-not $found) { $lines += $replacement }
        }
        [IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    }
    Write-Host 'Saved verified Supabase connection URLs in both ignored .env.local files. No migrations were run.'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secure.Dispose()
    $password = $null
    $encoded = $null
    $sessionUrl = $null
    $transactionUrl = $null
    $connectionBase = $null
    $values = $null
    [Environment]::SetEnvironmentVariable('CHATBOT_SUPABASE_PROBE_URL', $previousProbeUrl, 'Process')
}
