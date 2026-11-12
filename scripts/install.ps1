# carls-code installer for Windows 10 and 11.
#
# Installs Node.js (via winget, Chocolatey or the official MSI) when it is
# missing, then installs carls under %LOCALAPPDATA%\carls, adds a shim to PATH
# and writes a user-level config.
#
# Usage (PowerShell, no admin required when Node.js is already installed):
#   .\scripts\install.ps1
#   .\scripts\install.ps1 -Provider nvidia -ApiKey $env:NVIDIA_API_KEY
#   .\scripts\install.ps1 -Prefix "$env:USERPROFILE\carls" -Uninstall
#
# Parameters:
#   -Prefix <dir>     install prefix (default: %LOCALAPPDATA%\carls)
#   -Provider <id>    provider id; see `carls --providers`
#   -Model <id>       default model written to the config
#   -BaseUrl <url>    API base URL for a custom or self-hosted endpoint
#   -ApiKey <key>     API key written to the config (prefer an environment variable)
#   -Mode <mode>      plan | pair | ask | build | auto | yolo
#   -Effort <level>   minimal | low | medium | high
#   -NoNode           never install Node.js; fail if it is missing
#   -Ref <ref>        git tag or branch to install (default: main)
#   -Uninstall        remove the install prefix, the shim and the config
#   -Yes              accept defaults, no prompts
#
# One-liner (no clone, no admin when Node.js is present):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/carlscodev/carls-agent-v2/main/scripts/install.ps1))) -Yes
#
# The script is self-bootstrapping: downloaded on its own it fetches the
# requested ref and re-runs the real installer from inside it.

[CmdletBinding()]
param(
  [string]$Prefix = "",
  [string]$Provider = "",
  [string]$Model = "",
  [string]$BaseUrl = "",
  [string]$ApiKey = "",
  [string]$Mode = "",
  [string]$Effort = "",
  [string]$Ref = "",
  [switch]$NoNode,
  [switch]$Uninstall,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$NodeMajor = 20
$LogFile = Join-Path $env:TEMP "carls-install-$PID.log"

# --------------------------------------------------------- remote bootstrap
# `irm ... | iex` has no checkout beside it, so the sources the build needs are
# missing. Download the ref once and run the real installer from that tree.
$RepoSlug = if ($env:CARLS_REPO) { $env:CARLS_REPO } else { "carlscodev/carls-agent-v2" }
$TargetRef = if ($Ref) { $Ref } elseif ($env:CARLS_REF) { $env:CARLS_REF } else { "main" }

if ($env:CARLS_BOOTSTRAPPED -ne "1") {
  $root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { "" }
  if (-not $root -or -not (Test-Path (Join-Path $root "package.json"))) {
    Write-Host "· fetching carls-code $TargetRef from $RepoSlug"
    $stage = Join-Path ([IO.Path]::GetTempPath()) ("carls-bootstrap-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $archive = Join-Path $stage "src.zip"
    try {
      Invoke-WebRequest -Uri "https://codeload.github.com/$RepoSlug/zip/$TargetRef" -OutFile $archive -UseBasicParsing
      Expand-Archive -Path $archive -DestinationPath $stage -Force
    } catch {
      Write-Host "✗ could not download $RepoSlug at $TargetRef`: $($_.Exception.Message)"
      exit 1
    }
    $tree = Get-ChildItem -Path $stage -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "package.json") } |
      Select-Object -First 1
    if (-not $tree) {
      Write-Host "✗ the downloaded archive has no package.json; check the ref name."
      exit 1
    }
    $env:CARLS_BOOTSTRAPPED = "1"
    $env:CARLS_REF = $TargetRef
    & (Join-Path $tree.FullName "scripts\install.ps1") @PSBoundParameters
    exit $LASTEXITCODE
  }
}

function Say([string]$text) { Write-Host $text }
function Info([string]$text) { Write-Host "· $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "✓ $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Warning $text }
function Die([string]$text) { Write-Host "✗ $text" -ForegroundColor Red; exit 1 }

function Have([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $Prefix) {
  $Prefix = Join-Path $env:LOCALAPPDATA "carls"
}
$AppDir = Join-Path $Prefix "app"
$BinDir = Join-Path $Prefix "bin"

function Uninstall-Carls {
  Info "Removing carls…"
  $shim = Join-Path $BinDir "carls.cmd"
  if (Test-Path $shim) { Remove-Item $shim -Force; Ok "Removed $shim" }

  # Drop our directory from the user PATH.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -and $userPath.Contains($BinDir)) {
    $clean = ($userPath.Split(";") | Where-Object { $_ -and $_ -ne $BinDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $clean, "User")
    Ok "Removed $BinDir from the user PATH"
  }
  if (Test-Path $Prefix) { Remove-Item $Prefix -Recurse -Force; Ok "Removed $Prefix" }
  $config = Join-Path $env:APPDATA "carls\.carlsrc.json"
  if (Test-Path $config) { Remove-Item $config -Force; Ok "Removed $config" }
  Ok "Uninstalled."
}

function Get-NodeMajor {
  try { return [int](& node -v).TrimStart("v").Split(".")[0] } catch { return 0 }
}

function Install-Node {
  if ($NoNode) { Die "Node.js >= $NodeMajor is required and -NoNode was given." }
  Info "Installing Node.js…"

  if (Have winget) {
    try {
      & winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-File -Append $LogFile
      if ((Get-NodeMajor) -ge $NodeMajor) { Ok "Installed Node.js via winget"; return }
    } catch { Warn "winget could not install Node.js; trying the next method." }
  }
  if (Have choco) {
    try {
      & choco install nodejs-lts -y | Out-File -Append $LogFile
      if ((Get-NodeMajor) -ge $NodeMajor) { Ok "Installed Node.js via Chocolatey"; return }
    } catch { Warn "Chocolatey could not install Node.js; trying the MSI." }
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 20
  $latest = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version
  if (-not $latest) { Die "Could not resolve a Node.js v$NodeMajor release." }

  $msi = Join-Path $env:TEMP "node-$latest-$arch.msi"
  $url = "https://nodejs.org/dist/$latest/node-$latest-$arch.msi"
  Info "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
  $arguments = @("/i", "`"$msi`"", "/qn", "/norestart")
  if (Test-Admin) { Start-Process msiexec.exe -ArgumentList $arguments -Wait }
  else {
    # Per-user install needs no elevation.
    $arguments += "ADDLOCAL=ALL"
    Start-Process msiexec.exe -ArgumentList $arguments -Wait
  }
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  # Refresh PATH from the machine and user scopes so `node` resolves now.
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  if ((Get-NodeMajor) -lt $NodeMajor) { Die "Node.js install finished but node is not on PATH. Open a new terminal and re-run." }
  Ok "Installed Node.js $(& node -v)"
}

function Write-Shim {
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $shim = Join-Path $BinDir "carls.cmd"
  $entry = Join-Path $AppDir "dist\src\index.js"
  # %* forwards every argument; quoting keeps paths with spaces working.
  $body = "@echo off`r`nnode `"$entry`" %*`r`n"
  Set-Content -Path $shim -Value $body -Encoding ASCII
  Ok "Wrote $shim"

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath -or -not $userPath.Contains($BinDir)) {
    $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Ok "Added $BinDir to the user PATH (open a new terminal to pick it up)"
  }
  $env:Path = "$env:Path;$BinDir"
}

function Invoke-Build {
  Info "Building in $AppDir"
  Push-Location $AppDir
  try {
    & npm install --no-audit --no-fund *>> $LogFile
    if ($LASTEXITCODE -ne 0) { Die "npm install failed (see $LogFile)" }
    & npm run build *>> $LogFile
    if ($LASTEXITCODE -ne 0) { Die "build failed (see $LogFile)" }
    & npm prune --omit=dev *>> $LogFile
  } finally {
    Pop-Location
  }
}

function Write-Config {
  $config = Join-Path $env:APPDATA "carls\.carlsrc.json"
  $arguments = @("$AppDir\dist\src\setup\writeConfig.js", "--out", $config)
  if ($Mode) { $arguments += @("--mode", $Mode) }
  if ($Provider) { $arguments += @("--provider", $Provider) }
  if ($Model) { $arguments += @("--model", $Model) }
  if ($BaseUrl) { $arguments += @("--base-url", $BaseUrl) }
  if ($Effort) { $arguments += @("--effort", $Effort) }
  if ($ApiKey) { $arguments += @("--api-key", $ApiKey) }

  & node @arguments *>> $LogFile
  if ($LASTEXITCODE -ne 0) { Die "Failed to write $config (see $LogFile)" }
  # A key may live in this file, so keep it readable only by this account.
  try {
    $acl = Get-Acl $config
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -Path $config -AclObject $acl
  } catch { Warn "Could not restrict permissions on $config." }
  Ok "Wrote $config"
}

# The provider registry in dist/ is the single source of truth for ids and their
# credential variables, so adding a provider never means editing this script.
function Get-ProviderRegistry {
  $script = @'
import(process.argv[1]).then((m) => {
  process.stdout.write(JSON.stringify(m.PROVIDERS.map((p) => ({ id: p.id, env: p.apiKeyEnv }))));
}).catch(() => process.stdout.write("[]"));
'@
  try {
    return @(& node -e $script (Join-Path $AppDir "dist\src\providers\registry.js") | ConvertFrom-Json)
  } catch { return @() }
}

function Find-Credential {
  if ($ApiKey) { return $ApiKey }
  foreach ($provider in Get-ProviderRegistry) {
    foreach ($name in $provider.env) {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ($value) { return $value }
    }
  }
  return ""
}

# Returns the provider id whose credential variable is set, else "".
function Detect-Provider {
  if ($Provider) { return $Provider }
  foreach ($provider in Get-ProviderRegistry) {
    foreach ($name in $provider.env) {
      if ([Environment]::GetEnvironmentVariable($name)) { return $provider.id }
    }
  }
  return ""
}

# ------------------------------------------------------------------- entry

if ($Uninstall) { Uninstall-Carls; exit 0 }

if ((Get-NodeMajor) -lt $NodeMajor) { Install-Node } else { Ok "Node.js $(& node -v) already installed" }

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot "package.json"))) {
  Die "Run this script from the repository root (package.json not found in $repoRoot)."
}

Info "Installing into $Prefix"
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
# Copy sources only; node_modules and dist are rebuilt.
Get-ChildItem -Path $repoRoot -Force |
  Where-Object { $_.Name -notin @("node_modules", "dist", ".git") } |
  Copy-Item -Destination $AppDir -Recurse -Force

Invoke-Build
Write-Shim

# Prefer the provider whose key is already in the environment, so a Windows
# machine with NVIDIA_API_KEY set needs no further questions.
if (-not $Provider) {
  $detected = Detect-Provider
  if ($detected) { $Provider = $detected }
}
Write-Config

$key = Find-Credential
Say ""
Say "Installed"
Say "  binary   $BinDir\carls.cmd"
Say "  config   $env:APPDATA\carls\.carlsrc.json"
Say "  provider $(if ($Provider) { $Provider } else { 'anthropic (change it with carls --setup)' })"
Say ""
Say "Run carls to start, or carls `"your task`" for one shot."
if (-not $key) {
  Say "No API key was found: the first run asks for a provider and a key."
  Say "Reconfigure any time with carls --setup; list providers with carls --providers."
}
