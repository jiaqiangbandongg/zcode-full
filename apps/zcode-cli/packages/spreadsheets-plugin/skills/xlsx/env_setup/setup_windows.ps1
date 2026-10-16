#Requires -Version 5.1
<#
.SYNOPSIS
    XLSX Skill — Environment Setup for Windows (Win10/Win11)
.DESCRIPTION
    Detects platform, checks and installs all dependencies for the XLSX skill.
    Supports China mirror fallback for pip.
#>

param(
    [switch]$UseChinaMirror
)

$ErrorActionPreference = "Continue"

function Write-Ok    { param($msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail  { param($msg) Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Warn  { param($msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Info  { param($msg) Write-Host "  [->] $msg" -ForegroundColor Cyan }

# ── Resolve XLSX_SKILL_DIR ──
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$XLSX_SKILL_DIR = Split-Path -Parent $ScriptDir
$env:XLSX_SKILL_DIR = $XLSX_SKILL_DIR

Write-Host "============================================"
Write-Host "  XLSX Skill - Environment Setup"
Write-Host "  (Windows)"
Write-Host "============================================"
Write-Host ""

# ── Step 1: Platform Detection ──
$WinVer = [System.Environment]::OSVersion.Version
$WinName = if ($WinVer.Build -ge 22000) { "Windows 11" } elseif ($WinVer.Build -ge 10240) { "Windows 10" } else { "Windows (older)" }
Write-Host "Platform: $WinName (Build $($WinVer.Build)), $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"
Write-Host "XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
Write-Host ""

# ── China mirror detection ──
$PipMirrorArgs = @()

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
    Write-Info "China mirrors enabled (pip: tuna)"
    Write-Host ""
}

$Errors = 0

# ── Step 2a: Python 3 ──
Write-Host "--- [1/5] Python 3 + pip ---"
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
}
Write-Host ""

# ── Step 2b: Python packages ──
Write-Host "--- [2/5] Python Packages (openpyxl, XlsxWriter) ---"
$PyPkgs = @(
    @{ Module = "openpyxl";   Package = "openpyxl" },
    @{ Module = "xlsxwriter"; Package = "XlsxWriter" }
)

$MissingPy = @()
if ($PyCmd) {
    foreach ($pkg in $PyPkgs) {
        try {
            $result = & $PyCmd -c "import $($pkg.Module); print(getattr($($pkg.Module), '__version__', 'ok'))" 2>&1
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

# ── Step 2c: LibreOffice (install-on-demand, NOT substitutable) ──
Write-Host "--- [3/5] LibreOffice (format conversion + formula recalc) ---"
$SofficePath = "C:\Program Files\LibreOffice\program\soffice.exe"
if (Test-Path $SofficePath) {
    Write-Ok "libreoffice found"
} elseif (Get-Command soffice -ErrorAction SilentlyContinue) {
    Write-Ok "libreoffice (in PATH)"
} else {
    Write-Warn "libreoffice not installed - REQUIRED for recalc, .xlsx -> PDF, .csv -> .xlsx"
    Write-Info "You MUST install it. FORBIDDEN: using Excel/WPS/Numbers instead of installing,"
    Write-Info "or skipping recalculation. A large download is NOT a reason to skip. REQUIRED:"
    Write-Info "explain the necessity to the user, say the package is large, THEN install it."
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

# ── Step 2d: Font Installation (from CDN) ──
Write-Host "--- [4/5] Font Installation ---"
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

# Set XLSX_FONTS_DIR to user font directory (fonts are now installed there)
$XLSX_FONTS_DIR = $UserFontDir
$env:XLSX_FONTS_DIR = $XLSX_FONTS_DIR
Write-Host ""

# ── Step 2e: CJK Font Verification ──
Write-Host "--- [5/5] CJK Font Verification ---"
$CjkFound = $false
$FontsDir = Join-Path $env:WINDIR "Fonts"
$UserFontDir2 = Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts"
$CjkFonts = @("NotoSansSC[wght].ttf", "NotoSerifSC-Regular.ttf")
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
Write-Host "  XLSX_SKILL_DIR=$XLSX_SKILL_DIR"
Write-Host "  XLSX_FONTS_DIR=$XLSX_FONTS_DIR (user font directory)"
Write-Host "============================================"
