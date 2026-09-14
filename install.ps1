<#
.SYNOPSIS
    Automated Windows installer for Agent Workbench (Mulit-Harness-ADE).

.DESCRIPTION
    Fetches the latest release from GitHub, downloads the installer,
    and runs the setup wizard.

.PARAMETER Tag
    Specific release tag to install (default: "latest").

.PARAMETER Silent
    Silent installation without GUI wizard prompts.

.PARAMETER DownloadOnly
    Download the installer to the current directory without running it.

.PARAMETER Portable
    Download the portable package instead of the setup installer (if available).

.EXAMPLE
    irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex
#>

[CmdletBinding()]
param(
    [string]$Tag = "latest",
    [switch]$Silent,
    [switch]$DownloadOnly,
    [switch]$Portable
)

$ErrorActionPreference = "Stop"

# Enable modern TLS protocols
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

$RepoOwner = "zkylek1212-k"
$RepoName = "Mulit-Harness-ADE"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "         Agent Workbench - Windows Quick Installer        " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$ApiUrl = if ($Tag -eq "latest") {
    "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
} else {
    "https://api.github.com/repos/$RepoOwner/$RepoName/releases/tags/$Tag"
}

Write-Host "Checking for latest release from GitHub..." -ForegroundColor Gray

$Headers = @{
    "User-Agent" = "AgentWorkbench-Installer"
    "Accept"     = "application/vnd.github.v3+json"
}

$Release = $null
try {
    $Release = Invoke-RestMethod -Uri $ApiUrl -Headers $Headers -Method Get
} catch {
    # Fallback to general releases list if /latest is not populated or redirects
    try {
        $Releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$RepoOwner/$RepoName/releases" -Headers $Headers -Method Get
        if ($Releases.Count -gt 0) {
            $Release = $Releases[0]
        }
    } catch {
        # ignore and handle below
    }
}

if (-not $Release) {
    Write-Host "[ERROR] Could not retrieve release info from GitHub API." -ForegroundColor Red
    Write-Host "Please download the installer directly from:" -ForegroundColor Yellow
    Write-Host "https://github.com/$RepoOwner/$RepoName/releases" -ForegroundColor Cyan
    exit 1
}

$ReleaseTag = $Release.tag_name
$ReleaseTitle = if ($Release.name) { $Release.name } else { $ReleaseTag }
Write-Host "Found Release: $ReleaseTitle ($ReleaseTag)" -ForegroundColor Green

# Locate appropriate asset
$Asset = $null
if ($Portable) {
    $Asset = $Release.assets | Where-Object { $_.name -like "*portable*" -or $_.name -like "*.zip" } | Select-Object -First 1
}

if (-not $Asset) {
    # Look for Windows setup installer (.exe, not blockmap, not portable)
    $Asset = $Release.assets | Where-Object {
        $_.name -like "*.exe" -and
        $_.name -notlike "*.blockmap" -and
        $_.name -notlike "*portable*"
    } | Select-Object -First 1
}

if (-not $Asset) {
    # Fallback: any .exe in assets
    $Asset = $Release.assets | Where-Object {
        $_.name -like "*.exe" -and $_.name -notlike "*.blockmap"
    } | Select-Object -First 1
}

if (-not $Asset) {
    Write-Host ""
    Write-Host "[NOTICE] Pre-built binary asset is not yet available in release $ReleaseTag." -ForegroundColor Yellow
    Write-Host "Please check the release page for updates: $($Release.html_url)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Alternatively, you can run from source code:" -ForegroundColor Gray
    Write-Host "  git clone https://github.com/$RepoOwner/$RepoName.git" -ForegroundColor Gray
    Write-Host "  cd $RepoName" -ForegroundColor Gray
    Write-Host "  npm install" -ForegroundColor Gray
    Write-Host "  npm run dev" -ForegroundColor Gray
    exit 0
}

$FileName = $Asset.name
$DownloadUrl = $Asset.browser_download_url
$FileSizeMB = [math]::Round($Asset.size / 1MB, 2)

$DestDir = if ($DownloadOnly) { (Get-Location).Path } else { $env:TEMP }
$DestPath = Join-Path $DestDir $FileName

Write-Host "Downloading $FileName ($FileSizeMB MB)..." -ForegroundColor Cyan
Write-Host "From: $DownloadUrl" -ForegroundColor Gray

try {
    # Use WebClient for reliable download
    $WebClient = New-Object System.Net.WebClient
    $WebClient.Headers.Add("User-Agent", "AgentWorkbench-Installer")
    $WebClient.DownloadFile($DownloadUrl, $DestPath)
} catch {
    Write-Host "Retrying download with Invoke-WebRequest..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $DestPath -UseBasicParsing
}

Write-Host "Download completed successfully!" -ForegroundColor Green
Write-Host "Saved to: $DestPath" -ForegroundColor Gray

if ($DownloadOnly) {
    Write-Host ""
    Write-Host "[SUCCESS] Installer downloaded to $DestPath" -ForegroundColor Green
    Write-Host "You can execute it whenever you are ready." -ForegroundColor Cyan
    exit 0
}

# Run the installer
Write-Host ""
Write-Host "Launching installer..." -ForegroundColor Cyan

if ($FileName.EndsWith(".exe")) {
    $ProcessArgs = @{
        FilePath = $DestPath
    }
    if ($Silent) {
        $ProcessArgs["ArgumentList"] = "/S"
        Write-Host "Executing silent installation..." -ForegroundColor Gray
    }
    $proc = Start-Process @ProcessArgs -PassThru
    if ($Silent) {
        $proc.WaitForExit()
        Write-Host ""
        Write-Host "[SUCCESS] Agent Workbench has been installed!" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "[SUCCESS] Setup wizard started. Follow the on-screen steps." -ForegroundColor Green
    }
} elseif ($FileName.EndsWith(".zip")) {
    $ExtractDir = Join-Path $env:LOCALAPPDATA "Programs\AgentWorkbench"
    Write-Host "Extracting portable files to $ExtractDir..." -ForegroundColor Cyan
    Expand-Archive -Path $DestPath -DestinationPath $ExtractDir -Force
    Write-Host "[SUCCESS] Extracted to $ExtractDir" -ForegroundColor Green
    $ExePath = Join-Path $ExtractDir "Agent Workbench.exe"
    if (Test-Path $ExePath) {
        Start-Process -FilePath $ExePath
    }
}
