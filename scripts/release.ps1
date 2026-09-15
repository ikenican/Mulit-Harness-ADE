<#
.SYNOPSIS
    Automated Release & Publish Workflow for Agent Workbench (Mulit-Harness-ADE).
    (Maintainers only - requires repository write permissions via GitHub CLI 'gh')

.DESCRIPTION
    1. Validates GitHub CLI authentication (`gh`).
    2. Reads version from `package.json` (e.g. 0.1.3 -> v0.1.3).
    3. Runs TypeScript typecheck.
    4. Builds production installer and packages (npm run dist).
    5. Packages win-unpacked directory into a portable ZIP package.
    6. Creates or updates GitHub Release via `gh release` (supports assets up to 2GB).
    7. Uploads setup .exe, portable .zip, and latest.yml auto-updater metadata.
    8. Optionally copies assets to a local Google Drive folder if specified.

.PARAMETER Notes
    Optional release notes text or path to markdown notes. Defaults to latest git commit summary.

.PARAMETER SkipBuild
    Skip typecheck and `npm run dist` if build was already performed recently.

.PARAMETER Draft
    Publish as a GitHub draft release rather than immediately public.

.PARAMETER GoogleDrivePath
    Optional local directory path (e.g. "G:\My Drive\AgentWorkbench") to copy backups.

.EXAMPLE
    # Standard one-click release:
    npm run release

    # Release without rebuilding:
    powershell -ExecutionPolicy Bypass -File ./scripts/release.ps1 -SkipBuild
#>

[CmdletBinding()]
param(
    [string]$Notes = "",
    [switch]$SkipBuild,
    [switch]$Draft,
    [string]$GoogleDrivePath = ""
)

$ErrorActionPreference = "Stop"

# Ensure modern TLS protocols
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       Agent Workbench - Automated Release Publisher      " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

# 0. Check GitHub CLI installation and authentication
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    if (Test-Path "C:\Program Files\GitHub CLI\gh.exe") {
        $env:PATH = "C:\Program Files\GitHub CLI;$env:PATH"
    } elseif (Test-Path "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe") {
        $env:PATH = "$env:LOCALAPPDATA\Programs\GitHub CLI;$env:PATH"
    }
}

Write-Host "Checking GitHub CLI (gh) status..." -ForegroundColor Gray
try {
    $ghVersion = gh --version 2>&1 | Select-Object -First 1
    Write-Host "  -> Found: $ghVersion" -ForegroundColor Gray
} catch {
    Write-Host "[ERROR] GitHub CLI ('gh') is not found in PATH." -ForegroundColor Red
    Write-Host "Please install it from https://cli.github.com/ or run: winget install GitHub.cli" -ForegroundColor Yellow
    exit 1
}

$authCheck = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] GitHub CLI is not logged in." -ForegroundColor Red
    Write-Host "Please run: gh auth login" -ForegroundColor Yellow
    exit 1
}
Write-Host "  -> GitHub authentication verified." -ForegroundColor Green

# 1. Read version from package.json
if (-not (Test-Path "package.json")) {
    Write-Host "[ERROR] package.json not found in current directory!" -ForegroundColor Red
    exit 1
}

$pkg = Get-Content -Raw "package.json" | ConvertFrom-Json
$version = $pkg.version
$tagName = "v$version"
$releaseTitle = "v$version"

Write-Host ""
Write-Host "Target Release Version: " -NoNewline -ForegroundColor White
Write-Host "$tagName" -ForegroundColor Cyan
Write-Host "Repository: zkylek1212-k/Mulit-Harness-ADE" -ForegroundColor Gray
Write-Host ""

# 2. Typecheck & Build
if (-not $SkipBuild) {
    Write-Host "==========================================" -ForegroundColor DarkGray
    Write-Host "[Step 1/4] Running TypeScript Typecheck..." -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor DarkGray
    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] TypeScript typecheck failed! Aborting release." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Typecheck passed with 0 errors." -ForegroundColor Green

    Write-Host ""
    Write-Host "==========================================" -ForegroundColor DarkGray
    Write-Host "[Step 2/4] Building Distributables (npm run dist)..." -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor DarkGray
    npm run dist
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] npm run dist failed! Aborting release." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] electron-builder finished successfully." -ForegroundColor Green
} else {
    Write-Host "[Notice] -SkipBuild specified: Skipping typecheck and electron-builder." -ForegroundColor Yellow
}

# 3. Create Portable ZIP from release/win-unpacked
Write-Host ""
Write-Host "==========================================" -ForegroundColor DarkGray
Write-Host "[Step 3/4] Packaging Portable Green ZIP..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor DarkGray

$portableZip = "release\Agent-Workbench-$version-portable.zip"
if (Test-Path "release\win-unpacked") {
    if (Test-Path $portableZip) {
        Remove-Item $portableZip -Force
    }
    Write-Host "Compressing release\win-unpacked -> $portableZip..." -ForegroundColor Gray
    Compress-Archive -Path "release\win-unpacked\*" -DestinationPath $portableZip -Force
    $zipSizeMB = [math]::Round((Get-Item $portableZip).Length / 1MB, 2)
    Write-Host "[OK] Portable ZIP package created ($zipSizeMB MB)." -ForegroundColor Green
} else {
    Write-Host "[Warning] release\win-unpacked not found; portable ZIP skipped." -ForegroundColor Yellow
}

# 4. Gather Assets for GitHub Release
Write-Host ""
Write-Host "==========================================" -ForegroundColor DarkGray
Write-Host "[Step 4/4] Publishing to GitHub Releases ($tagName)..." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor DarkGray

$setupExe = Get-ChildItem "release" -Filter "*$version*-setup.exe" | Select-Object -First 1
$latestYml = "release\latest.yml"
$blockmap = Get-ChildItem "release" -Filter "*$version*.blockmap" | Select-Object -First 1

# Normalize spaces to hyphens so GitHub Release URLs match latest.yml and avoid 404
if ($setupExe -and $setupExe.Name -match '\s') {
    $cleanExeName = $setupExe.Name -replace '\s+', '-'
    $cleanExePath = Join-Path $setupExe.DirectoryName $cleanExeName
    Copy-Item $setupExe.FullName $cleanExePath -Force
    $setupExe = Get-Item $cleanExePath
}
if ($blockmap -and $blockmap.Name -match '\s') {
    $cleanBlockmapName = $blockmap.Name -replace '\s+', '-'
    $cleanBlockmapPath = Join-Path $blockmap.DirectoryName $cleanBlockmapName
    Copy-Item $blockmap.FullName $cleanBlockmapPath -Force
    $blockmap = Get-Item $cleanBlockmapPath
}

$uploadFiles = @()
if ($setupExe) { $uploadFiles += $setupExe.FullName }
if (Test-Path $latestYml) { $uploadFiles += (Resolve-Path $latestYml).Path }
if ($blockmap) { $uploadFiles += $blockmap.FullName }
if (Test-Path $portableZip) { $uploadFiles += (Resolve-Path $portableZip).Path }

if ($uploadFiles.Count -eq 0) {
    Write-Host "[ERROR] No release files found in release\ directory to publish!" -ForegroundColor Red
    exit 1
}

Write-Host "Assets prepared for upload:" -ForegroundColor White
foreach ($f in $uploadFiles) {
    $item = Get-Item $f
    $mb = [math]::Round($item.Length / 1MB, 2)
    Write-Host "  * $($item.Name) ($mb MB)" -ForegroundColor Cyan
}

# Determine release notes
$releaseNotes = $Notes
if ($Notes -and (Test-Path $Notes -ErrorAction SilentlyContinue)) {
    try {
        $releaseNotes = Get-Content -Raw $Notes
    } catch {}
}
if (-not $releaseNotes) {
    try {
        $recentCommits = git log -n 5 --oneline 2>&1
        $releaseNotes = "### Changes in $tagName`n`n" + ($recentCommits -join "`n")
    } catch {
        $releaseNotes = "Release $tagName of Agent Workbench."
    }
}

# Check if release tag already exists on GitHub
$releaseExists = $false
try {
    $viewOut = gh release view $tagName --json tagName 2>&1
    if ($LASTEXITCODE -eq 0) {
        $releaseExists = $true
    }
} catch {
    $releaseExists = $false
}

if ($releaseExists) {
    Write-Host ""
    Write-Host "Release $tagName already exists on GitHub. Uploading and updating assets..." -ForegroundColor Yellow
    gh release upload $tagName $uploadFiles --clobber
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to upload assets to GitHub Release $tagName." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ""
    Write-Host "Creating new GitHub Release $tagName..." -ForegroundColor Green
    $createArgs = @(
        "release", "create", $tagName,
        "--title", $releaseTitle,
        "--notes", $releaseNotes
    )
    if ($Draft) {
        $createArgs += "--draft"
    }
    foreach ($f in $uploadFiles) {
        $createArgs += $f
    }
    & gh @createArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Failed to create GitHub Release $tagName." -ForegroundColor Red
        exit 1
    }
}

# 5. Optional Google Drive backup copy
if ($GoogleDrivePath) {
    if (Test-Path $GoogleDrivePath) {
        Write-Host ""
        Write-Host "Copying assets to local Google Drive backup folder..." -ForegroundColor Cyan
        foreach ($f in $uploadFiles) {
            Copy-Item -Path $f -Destination $GoogleDrivePath -Force
            Write-Host "  -> Copied $(Split-Path $f -Leaf) to $GoogleDrivePath" -ForegroundColor Green
        }
    } else {
        Write-Host "[Warning] GoogleDrivePath '$GoogleDrivePath' was not found. Skipped local copy." -ForegroundColor Yellow
    }
}

# Summary output
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "      Release $tagName Successfully Published!         " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Release Page URL:" -ForegroundColor White
Write-Host "  https://github.com/zkylek1212-k/Mulit-Harness-ADE/releases/tag/$tagName" -ForegroundColor Cyan
Write-Host ""
Write-Host "Auto-Updater:" -ForegroundColor White
Write-Host "  latest.yml uploaded; installed apps will detect and offer auto-update." -ForegroundColor Gray
Write-Host ""
Write-Host "Quick Install Command for Users:" -ForegroundColor White
Write-Host "  irm https://raw.githubusercontent.com/zkylek1212-k/Mulit-Harness-ADE/master/install.ps1 | iex" -ForegroundColor Yellow
Write-Host ""
