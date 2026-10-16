#Requires -Version 5.1
<#
.SYNOPSIS
    PDF Skill — Environment Setup for Windows (Win10/Win11)
.DESCRIPTION
    Detects platform, checks and installs all dependencies for the PDF skill.
    Supports China mirror fallback for pip/npm/playwright.
#>

param(
    [switch]$UseChinaMirror
)

$ErrorActionPreference = "Continue"

function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Warn  { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Info  { param($msg) Write-Host "  [->] $msg" -ForegroundColor Cyan }

# ── Resolve PDF_SKILL_DIR ──
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PDF_SKILL_DIR = Split-Path -Parent $ScriptDir
$env:PDF_SKILL_DIR = $PDF_SKILL_DIR

Write-Host "============================================"
Write-Host "  PDF Skill - Environment Setup"
Write-Host "  (Windows)"
Write-Host "============================================"
Write-Host ""

# ── Step 1: Platform Detection ──
$WinVer = [System.Environment]::OSVersion.Version
$WinName = if ($WinVer.Build -ge 22000) { "Windows 11" } elseif ($WinVer.Build -ge 10240) { "Windows 10" } else { "Windows (older)" }
Write-Host "Platform: $WinName (Build $($WinVer.Build)), $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
Write-Host "PDF_SKILL_DIR=$PDF_SKILL_DIR"
Write-Host ""

# ── China mirror detection ──
$PipMirrorArgs = @()
$NpmMirrorArgs = @()
$PlaywrightHost = ""

if ($UseChinaMirror) {
    $global:UseCN = $true
} else {
    try {
        $null = Invoke-WebRequest -Uri "https://pypi.org" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
        $global:UseCN = $false
    } catch {
        Write-Warn "pypi.org unreachable - enabling China mirrors"
        $global:UseCN = $true
    }
}

if ($global:UseCN) {
    $PipMirrorArgs = @("-i", "https://pypi.tuna.tsinghua.edu.cn/simple", "--trusted-host", "pypi.tuna.tsinghua.edu.cn")
    $NpmMirrorArgs = @("--registry", "https://registry.npmmirror.com")
    $PlaywrightHost = "https://npmmirror.com/mirrors/playwright/"
    Write-Info "China mirrors enabled (pip: tuna, npm: npmmirror, playwright: npmmirror)"
    Write-Host ""
}

$Errors = 0

# ── Step 2a: Python 3 ──
Write-Host "--- [1/9] Python 3 ---"
$PyCmd = $null
foreach ($cmd in @("python3", "python", "py")) {
    try {
        $ver = & $cmd --version 2>&1
        if ($ver -match "Python 3") {
            $PyCmd = $cmd
            Write-Ok "$cmd ($ver)"
            break
        }
    } catch {}
}
if (-not $PyCmd) {
    Write-Fail "Python 3 not found"
    Write-Info "Install option 1: winget install Python.Python.3.11"
    Write-Info "Install option 2: https://www.python.org/downloads/"
    Write-Info "Install option 3: choco install python3"
    if ($global:UseCN) {
        Write-Info "China alt: https://npmmirror.com/mirrors/python/"
    }
    $Errors++
}
Write-Host ""

# ── Step 2b: pip ──
Write-Host "--- [2/9] pip ---"
if ($PyCmd) {
    try {
        $pipVer = & $PyCmd -m pip --version 2>&1
        if ($pipVer -match "pip") {
            Write-Ok "pip ($pipVer)"
        } else { throw "no pip" }
    } catch {
        Write-Fail "pip not found"
        Write-Info "Install: $PyCmd -m ensurepip --upgrade"
        $Errors++
    }
} else {
    Write-Fail "pip - skipped (Python not found)"
    $Errors++
}
Write-Host ""

# ── Step 2c: Python packages ──
Write-Host "--- [3/9] Python Packages (pikepdf, pdfplumber, pypdf, reportlab, PyMuPDF) ---"
$PyPkgs = @(
    @{ Module = "pikepdf";    Package = "pikepdf" },
    @{ Module = "pdfplumber"; Package = "pdfplumber" },
    @{ Module = "pypdf";      Package = "pypdf" },
    @{ Module = "reportlab";  Package = "reportlab" },
    @{ Module = "fitz";       Package = "PyMuPDF" }
)

$MissingPy = @()
if ($PyCmd) {
    foreach ($pkg in $PyPkgs) {
        try {
            $result = & $PyCmd -c "import $($pkg.Module); print(getattr($($pkg.Module), '__version__', getattr($($pkg.Module), 'version', 'ok')))" 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$($pkg.Package) ($result)"
            } else { throw "not installed" }
        } catch {
            Write-Fail "$($pkg.Package) not installed"
            $MissingPy += $pkg.Package
        }
    }

    if ($MissingPy.Count -gt 0) {
        Write-Info "Installing: $($MissingPy -join ', ')"
        $installArgs = @("-m", "pip", "install") + $PipMirrorArgs + $MissingPy
        try {
            & $PyCmd @installArgs 2>&1 | Out-Null
            Write-Ok "Installed: $($MissingPy -join ', ')"
        } catch {
            Write-Fail "pip install failed. Try: $PyCmd -m pip install $($PipMirrorArgs -join ' ') $($MissingPy -join ' ')"
            $Errors++
        }
    }
} else {
    Write-Fail "Python packages - skipped (Python not found)"
}
Write-Host ""

# ── Step 2d: Node.js + npm (OPTIONAL — Creative/HTML pipeline only) ──
Write-Host "--- [4/9] Node.js + npm (optional: Creative/HTML pipeline) ---"
try {
    $nodeVer = & node --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "node ($nodeVer)"
    } else { throw "no node" }
} catch {
    Write-Warn "node not found (optional — only for the Creative/poster/HTML->PDF route)"
    Write-Info "Install on demand 1: winget install OpenJS.NodeJS.LTS"
    Write-Info "Install on demand 2: https://nodejs.org/"
    Write-Info "Install on demand 3: choco install nodejs-lts"
    if ($global:UseCN) {
        Write-Info "China alt: https://npmmirror.com/mirrors/node/"
    }
}

try {
    $npmVer = & npm --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "npm ($npmVer)"
    } else { throw "no npm" }
} catch {
    Write-Warn "npm not found (optional — installed with Node.js)"
}
Write-Host ""

# ── Step 2e: Playwright + Chromium (OPTIONAL — Creative/HTML pipeline only) ──
Write-Host "--- [5/9] Playwright + Chromium (optional: HTML->PDF engine) ---"
Write-Info "Optional. Covers now render with ReportLab; Playwright is only for Creative/poster/HTML->PDF."
Write-Info "Install on demand, with the user's confirmation (large download / long first-run wait)."
try {
    $null = & node -e "require('playwright')" 2>&1
    if ($LASTEXITCODE -eq 0) {
        $pwVer = & node -e "console.log(require('playwright/package.json').version)" 2>&1
        Write-Ok "playwright ($pwVer)"
    } else { throw "no pw" }
} catch {
    Write-Warn "playwright not installed (optional)"
    if ($global:UseCN) {
        Write-Info "Install on demand: npm install -g playwright@1.50.0 $($NpmMirrorArgs -join ' ')"
    } else {
        Write-Info "Install on demand: npm install -g playwright@1.50.0"
    }
}

$PwCache = Join-Path $env:LOCALAPPDATA "ms-playwright"
if (Test-Path "$PwCache\chromium-*") {
    Write-Ok "chromium installed"
} else {
    Write-Warn "chromium not installed (optional)"
    if ($global:UseCN) {
        Write-Info "Install on demand: `$env:PLAYWRIGHT_DOWNLOAD_HOST='$PlaywrightHost'; npx playwright install chromium"
    } else {
        Write-Info "Install on demand: npx playwright install chromium"
    }
}
Write-Host ""

# ── Step 2f: Tectonic (optional) ──
Write-Host "--- [6/9] Tectonic (optional, LaTeX/Academic PDFs) ---"
try {
    $tecVer = & tectonic --version 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "tectonic ($tecVer)"
    } else { throw "no tectonic" }
} catch {
    Write-Warn "tectonic not installed (needed only for LaTeX/academic PDFs)"
    Write-Info "Install option 1: scoop install tectonic"
    Write-Info "Install option 2: choco install tectonic"
}
Write-Host ""

# ── Step 2g: LibreOffice (install-on-demand, NOT substitutable) ──
Write-Host "--- [7/9] LibreOffice (Office->PDF conversion) ---"
$SofficePath = "C:\Program Files\LibreOffice\program\soffice.exe"
if (Test-Path $SofficePath) {
    Write-Ok "libreoffice found"
} elseif (Get-Command soffice -ErrorAction SilentlyContinue) {
    Write-Ok "libreoffice (in PATH)"
} else {
    Write-Warn "libreoffice not installed - REQUIRED for any .docx/.xlsx/.pptx -> PDF task"
    Write-Info "You MUST install it. FORBIDDEN: using Word/WPS/Keynote/Pages instead of"
    Write-Info "installing. A large download is NOT a reason to skip - it is expected to be large."
    Write-Info "REQUIRED: explain the necessity to the user, say the package is large, THEN install."
    Write-Info "PREFERRED source (fast in China, current build): Tsinghua TUNA mirror"
    Write-Info "  https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/"
    Write-Info "  Windows x64:   win/x86_64/LibreOffice_26.8.0_Win_x86-64.msi"
    Write-Info "  Windows ARM64: win/aarch64/LibreOffice_26.8.0_Win_aarch64.msi"
    Write-Info "  Then: msiexec /i <file>.msi /qn   (needs admin)"
    Write-Info "  If 26.8.0 is gone, pick the newest version under .../libreoffice/stable/"
    Write-Info "FALLBACK (only if the mirror is unreachable):"
    Write-Info "  winget install TheDocumentFoundation.LibreOffice"
    Write-Info "  or: https://www.libreoffice.org/download/"
    Write-Info "AFTER installing, REGISTER it on PATH (Windows method - differs per OS):"
    Write-Info '  setx PATH "$([Environment]::GetEnvironmentVariable(''PATH'',''User''));C:\Program Files\LibreOffice\program"'
    Write-Info "  setx affects NEW shells only - for this session use the full soffice.exe path."
    Write-Info '  then re-verify: & "C:\Program Files\LibreOffice\program\soffice.exe" --version'
    Write-Info "An install left off PATH looks 'not installed' next run and gets reinstalled"
    Write-Info "needlessly. If soffice already exists on disk but is off PATH, just register it."
    Write-Info "Another program is allowed ONLY after an install attempt has FAILED. Report it."
    Write-Info "No install attempt = no substitute program."
}
Write-Host ""

# ── Step 2h: Font Installation (from CDN) ──
Write-Host "--- [8/9] Font Installation ---"
$FontCdnBase = "https://z-cdn.chatglm.cn/office-skill/fonts"
$FontList = Join-Path $ScriptDir "font_list.txt"

$UserFontDir = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
if (-not (Test-Path $UserFontDir)) { New-Item -ItemType Directory -Path $UserFontDir -Force | Out-Null }

$Marker = Join-Path $UserFontDir ".office-skill-fonts-installed"
if (Test-Path $Marker) {
    Write-Ok "Fonts already installed (marker found). To re-install, delete $Marker"
} else {
    if (-not (Test-Path $FontList)) {
        Write-Fail "Font list not found: $FontList"
        $Errors++
    } else {
        $lines = Get-Content $FontList | Where-Object { $_.Trim() -ne "" }
        $Total = $lines.Count
        $Installed = 0; $Skipped = 0; $Failed = 0
        Write-Info "Downloading $Total fonts from CDN..."
        
        foreach ($relPath in $lines) {
            $fname = Split-Path $relPath -Leaf
            $dest = Join-Path $UserFontDir $fname
            
            if (Test-Path $dest) {
                $Skipped++
                continue
            }
            
            $encoded = $relPath -replace '\[','%5B' -replace '\]','%5D' -replace ' ','%20'
            $url = "$FontCdnBase/$encoded"
            
            try {
                Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 30 -ErrorAction Stop
                $regPath = "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
                $null = New-ItemProperty -Path $regPath -Name $fname -Value $dest -PropertyType String -Force -ErrorAction SilentlyContinue
                $Installed++
            } catch {
                Write-Warn "Failed to download: $relPath"
                $Failed++
                Remove-Item $dest -Force -ErrorAction SilentlyContinue
            }
        }
        
        if ($Failed -eq 0) {
            New-Item -ItemType File -Path $Marker -Force | Out-Null
            Write-Ok "Fonts: $Installed newly installed, $Skipped already present (target: $UserFontDir)"
        } else {
            Write-Warn "Fonts: $Installed installed, $Skipped skipped, $Failed failed (marker not written, will retry next run)"
            $Errors++
        }
    }
}

# Set PDF_FONTS_DIR to user font directory (fonts are now installed there)
$PDF_FONTS_DIR = $UserFontDir
$env:PDF_FONTS_DIR = $PDF_FONTS_DIR
Write-Host ""

# ── Step 2i: CJK Font Verification ──
Write-Host "--- [9/9] CJK Font Verification ---"
$CjkFound = $false
$FontsDir = Join-Path $env:WINDIR "Fonts"
$UserFontDir2 = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$CjkFonts = @("NotoSansSC[wght].ttf", "NotoSansSC[wght].ttf", "NotoSansSC[wght].ttf", "NotoSerifSC-Regular.ttf")
foreach ($f in $CjkFonts) {
    if ((Test-Path (Join-Path $FontsDir $f)) -or (Test-Path (Join-Path $UserFontDir2 $f))) {
        Write-Ok "CJK font found: $f"
        $CjkFound = $true
        break
    }
}

if (-not $CjkFound) {
    Write-Warn "No CJK font verified yet - fonts were just installed, restart may be needed"
}
Write-Host ""

# ── Summary ──
Write-Host "============================================"
if ($Errors -eq 0) {
    Write-Host "  All dependencies OK."
} else {
    Write-Host "  $Errors issue(s) found. Fix them above."
}
Write-Host "  PDF_SKILL_DIR=$PDF_SKILL_DIR"
Write-Host "============================================"
