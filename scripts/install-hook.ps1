param(
  [Parameter(Mandatory = $true)]
  [string]$Repository
)

$ErrorActionPreference = 'Stop'

$kitRoot = Split-Path -Parent $PSScriptRoot
$target = (Resolve-Path -LiteralPath $Repository).Path
$gitHooks = Join-Path $target '.githooks'
$runnerDir = Join-Path $target '.omp/review-kit'

New-Item -ItemType Directory -Force -Path $gitHooks | Out-Null
New-Item -ItemType Directory -Force -Path $runnerDir | Out-Null

Copy-Item -Force (Join-Path $kitRoot 'templates/githooks/pre-commit') (Join-Path $gitHooks 'pre-commit')
Copy-Item -Force (Join-Path $kitRoot 'scripts/run-review.mjs') (Join-Path $runnerDir 'run-review.mjs')

git -C $target config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
  throw "Unable to configure core.hooksPath in $target"
}

Write-Output "Installed omp-reviewer-kit hook in $target"
