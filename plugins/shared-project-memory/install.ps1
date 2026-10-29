# Standalone installer for Windows PowerShell - works WITHOUT Claude Code.
#
#   .\install.ps1              # install into current repo
#   .\install.ps1 C:\my\repo   # install into another repo
#
# Requires Git Bash (ships with Git for Windows), which the hooks need anyway.

param([string]$Target = $PWD)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Locate Git Bash rather than WSL bash if both are installed
$bash = "bash"
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCmd.Source)
    $candidate = Join-Path $gitRoot "bin\bash.exe"
    if (Test-Path $candidate) { $bash = $candidate }
}

Push-Location $Target
try {
    $env:CLAUDE_PLUGIN_ROOT = ($Here -replace '\\', '/')
    $script = "$($env:CLAUDE_PLUGIN_ROOT)/scripts/init-memory.sh"
    & $bash -l $script
    if ($LASTEXITCODE -ne 0) { throw "init-memory.sh failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}
