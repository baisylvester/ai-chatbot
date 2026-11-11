# Prompts for an AI provider API key (hidden input) and writes it into apps/dashboard/.env.local.
# The key is never printed. Usage (PowerShell):  & .\tools\set-provider-key.ps1
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\apps\dashboard\.env.local'
if (-not (Test-Path $envFile)) { throw "Not found: $envFile" }

$options = [ordered]@{
  '1' = 'OPENAI_API_KEY'
  '2' = 'ANTHROPIC_API_KEY'
  '3' = 'GOOGLE_GENERATIVE_AI_API_KEY'
  '4' = 'DEEPSEEK_API_KEY'
}
Write-Host 'Which provider is the key for?'
foreach ($k in $options.Keys) { Write-Host "  $k) $($options[$k])" }
$choice = Read-Host 'Enter 1-4'
$name = $options[$choice]
if (-not $name) { throw 'Invalid choice' }

$secure = Read-Host "Paste the $name value (input is hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
if ($value.Length -lt 10) { throw 'That key looks too short; nothing was written.' }

$lines = [IO.File]::ReadAllLines($envFile)
$found = $false
$out = foreach ($line in $lines) {
  if ($line -match "^\s*$name\s*=") { $found = $true; "$name=$value" } else { $line }
}
if (-not $found) { $out = @($out) + "$name=$value" }
# UTF-8 without BOM so the first variable name is parsed correctly.
[IO.File]::WriteAllText((Resolve-Path $envFile), (($out -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
$value = $null
Write-Host "Saved $name to apps\dashboard\.env.local ($((Get-Item $envFile).LastWriteTime))."
