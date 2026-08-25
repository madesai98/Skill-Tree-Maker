const RELEASE_API = 'https://api.github.com/repos/openai/tunnel-client/releases/latest';
const RELAY_VERSION = '5.0.1';
const RELAY_INVOKE_TIMEOUT_MS = '125000';
const BRIDGE_ALIAS = 'skill-tree-maker';

function psSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function powerShellBody(platform: string, tunnelId: string, apiKey: string, origin: string) {
  const nodeArch = platform.endsWith('arm64') ? 'arm64' : 'x64';
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$TunnelId = ${psSingleQuote(tunnelId)}
$RuntimeApiKey = ${psSingleQuote(apiKey)}
$Platform = ${psSingleQuote(platform)}
$WidgetOrigin = ${psSingleQuote(origin)}
$RelayVersion = ${psSingleQuote(RELAY_VERSION)}
$RelayInvokeTimeout = ${psSingleQuote(RELAY_INVOKE_TIMEOUT_MS)}
$Alias = ${psSingleQuote(BRIDGE_ALIAS)}
$ReleaseApi = ${psSingleQuote(RELEASE_API)}
$Root = Split-Path -Parent $env:STM_SCRIPT_PATH
$ToolsDir = Join-Path $Root 'tools'
$TunnelDir = Join-Path $ToolsDir 'tunnel-client'
$NodeDir = Join-Path $ToolsDir 'node'
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

function Write-Step([string]$Message) { Write-Host "[Skill Tree Maker] $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "[Skill Tree Maker] ERROR: $Message" -ForegroundColor Red; exit 1 }

Write-Step 'Checking the latest OpenAI tunnel-client release...'
$release = Invoke-RestMethod -Uri $ReleaseApi -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'Skill-Tree-Maker-Bridge' }
$tag = [string]$release.tag_name
if ([string]::IsNullOrWhiteSpace($tag)) { Fail 'GitHub did not return a release tag.' }
$assetName = "tunnel-client-$tag-$Platform.zip"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) { Fail "The latest release $tag does not contain $assetName." }

$tunnelExe = $null
$globalTunnel = Get-Command tunnel-client -ErrorAction SilentlyContinue
if ($globalTunnel) {
  try {
    $globalVersion = (& $globalTunnel.Source --version 2>&1 | Out-String)
    if ($globalVersion -match [regex]::Escape($tag)) {
      $tunnelExe = $globalTunnel.Source
      Write-Step "Using existing tunnel-client $tag from PATH."
    }
  } catch { }
}

$versionFile = Join-Path $TunnelDir '.version'
if (-not $tunnelExe -and (Test-Path $versionFile) -and ((Get-Content $versionFile -Raw).Trim() -eq $tag)) {
  $cached = Get-ChildItem -Path $TunnelDir -Filter 'tunnel-client.exe' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cached) {
    $tunnelExe = $cached.FullName
    Write-Step "Using cached tunnel-client $tag."
  }
}

if (-not $tunnelExe) {
  Write-Step "Installing/updating tunnel-client to $tag..."
  $tempZip = Join-Path $env:TEMP $assetName
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tempZip -UseBasicParsing

  $sumsAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if ($sumsAsset) {
    $sums = (Invoke-WebRequest -Uri $sumsAsset.browser_download_url -UseBasicParsing).Content
    $escaped = [regex]::Escape($assetName)
    $match = [regex]::Match($sums, "(?mi)^([0-9a-f]{64})\\s+\\*?$escaped\\s*$")
    if (-not $match.Success) { Fail "Could not find $assetName in SHA256SUMS.txt." }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tempZip).Hash.ToLowerInvariant()
    if ($actual -ne $match.Groups[1].Value.ToLowerInvariant()) { Fail 'The tunnel-client download failed SHA256 verification.' }
  }

  if (Test-Path $TunnelDir) { Remove-Item -Recurse -Force $TunnelDir }
  New-Item -ItemType Directory -Force -Path $TunnelDir | Out-Null
  Expand-Archive -Path $tempZip -DestinationPath $TunnelDir -Force
  Remove-Item -Force $tempZip -ErrorAction SilentlyContinue
  Set-Content -Path $versionFile -Value $tag -NoNewline
  $cached = Get-ChildItem -Path $TunnelDir -Filter 'tunnel-client.exe' -File -Recurse | Select-Object -First 1
  if (-not $cached) { Fail 'The tunnel-client archive did not contain tunnel-client.exe.' }
  $tunnelExe = $cached.FullName
}

function Find-Npx {
  $cmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command npx -ErrorAction SilentlyContinue }
  if ($cmd) { return $cmd.Source }
  $local = Get-ChildItem -Path $NodeDir -Filter 'npx.cmd' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local) { return $local.FullName }
  return $null
}

$npx = Find-Npx
if (-not $npx) {
  Write-Step 'Node.js/npx was not found. Installing a portable Node.js LTS copy into this bridge folder...'
  $nodeIndex = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
  $nodeRelease = $nodeIndex | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $nodeRelease) { Fail 'Could not determine the current Node.js LTS release.' }
  $nodeVersion = [string]$nodeRelease.version
  $nodeAsset = "node-$nodeVersion-win-${nodeArch}.zip"
  $nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeAsset"
  $nodeZip = Join-Path $env:TEMP $nodeAsset
  Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
  if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
  New-Item -ItemType Directory -Force -Path $NodeDir | Out-Null
  Expand-Archive -Path $nodeZip -DestinationPath $NodeDir -Force
  Remove-Item -Force $nodeZip -ErrorAction SilentlyContinue
  $npx = Find-Npx
  if (-not $npx) { Fail 'Portable Node.js installed, but npx.cmd could not be found.' }
  Write-Step "Installed portable Node.js $nodeVersion."
}

$env:TUNNEL_RUNTIME_KEY = $RuntimeApiKey
$relayCommand = '"' + $npx + '" -y @mcp-b/webmcp-local-relay@' + $RelayVersion + ' --widget-origin ' + $WidgetOrigin + ' --invoke-timeout ' + $RelayInvokeTimeout

Write-Step 'Starting or refreshing the managed Skill Tree Maker tunnel runtime...'
& $tunnelExe runtimes connect --alias $Alias --tunnel-id $TunnelId --runtime-api-key 'env:TUNNEL_RUNTIME_KEY' --mcp-command $relayCommand
if ($LASTEXITCODE -ne 0) { Fail "tunnel-client runtimes connect failed with exit code $LASTEXITCODE." }

Start-Sleep -Seconds 2
Write-Step 'Checking runtime status...'
& $tunnelExe runtimes status $Alias --json
if ($LASTEXITCODE -ne 0) { Fail "tunnel-client runtimes status failed with exit code $LASTEXITCODE." }

Write-Host ''
Write-Host 'Bridge startup completed. Keep the Skill Tree Maker browser tab open and enable the same tunnel in ChatGPT.' -ForegroundColor Green
`;
}

function windowsLauncher(platform: string, tunnelId: string, apiKey: string) {
  const body = powerShellBody(platform, tunnelId, apiKey, window.location.origin).replace(/\r?\n/g, '\r\n');
  return `@echo off\r\nsetlocal\r\nset "STM_SCRIPT_PATH=%~f0"\r\nset "STM_PS_TEMP=%TEMP%\\skill-tree-maker-bridge-%RANDOM%-%RANDOM%.ps1"\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:STM_SCRIPT_PATH; $raw=[IO.File]::ReadAllText($p); $m='#'+'__STM_PS_PAYLOAD__'; $i=$raw.IndexOf($m); if($i -lt 0){exit 1}; [IO.File]::WriteAllText($env:STM_PS_TEMP,$raw.Substring($i+$m.Length),[Text.UTF8Encoding]::new($false))"\r\nif errorlevel 1 (\r\n  echo Failed to prepare the embedded PowerShell launcher.\r\n  pause\r\n  exit /b 1\r\n)\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%STM_PS_TEMP%"\r\nset "STM_EXIT=%ERRORLEVEL%"\r\ndel "%STM_PS_TEMP%" >nul 2>&1\r\necho.\r\npause\r\nexit /b %STM_EXIT%\r\n#__STM_PS_PAYLOAD__\r\n${body}`;
}

function showNotice(message: string) {
  const section = document.querySelector<HTMLElement>('.bridge-launch-section');
  if (!section) return;
  let notice = section.querySelector<HTMLElement>('.bridge-setup-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'bridge-setup-notice';
    section.append(notice);
  }
  notice.textContent = message;
}

function download(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const action = target.closest<HTMLElement>('[data-bridge-action]')?.dataset.bridgeAction;
  if (action !== 'download-script') return;

  const platform = document.querySelector<HTMLSelectElement>('[data-bridge-platform]')?.value ?? '';
  if (!platform.startsWith('windows-')) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const tunnelId = document.querySelector<HTMLInputElement>('[data-bridge-tunnel-id]')?.value.trim() ?? '';
  const apiKey = document.querySelector<HTMLInputElement>('[data-bridge-api-key]')?.value.trim() ?? '';
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    showNotice('Enter a valid tunnel ID (tunnel_ followed by 32 lowercase hexadecimal characters).');
    return;
  }
  if (!apiKey) {
    showNotice('Paste the restricted runtime API key. It is used only to generate the downloaded script and is not stored by this page.');
    return;
  }

  try {
    download(windowsLauncher(platform, tunnelId, apiKey), 'Start-SkillTreeMaker-Bridge.cmd');
    showNotice('Downloaded Start-SkillTreeMaker-Bridge.cmd. Put it in a private folder of your choice before running it; the script will create its tools directory beside itself.');
  } catch (error) {
    showNotice(error instanceof Error ? error.message : 'Could not download the Windows launch script.');
  }
}, true);
