param(
  [Parameter(Mandatory = $true)]
  [string]$Repository
)

$ErrorActionPreference = 'Stop'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "Node.js is required but was not found on PATH."
}

$kitRoot = Split-Path -Parent $PSScriptRoot
$target = (Resolve-Path -LiteralPath $Repository).Path
$setupScript = Join-Path $kitRoot 'scripts/setup-hook.mjs'

& node $setupScript $target
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
