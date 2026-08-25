import './webMcpEnvironmentSetup.css';

const RELEASE_API = 'https://api.github.com/repos/openai/tunnel-client/releases/latest';
const TUNNELS_URL = 'https://platform.openai.com/settings/organization/tunnels';
const API_KEYS_URL = 'https://platform.openai.com/settings/organization/api-keys';
const CHATGPT_CONNECTORS_URL = 'https://chatgpt.com/#settings/Connectors';
const SETTINGS_KEY = 'skill-tree:bridge-launch-setup:v1';
const LEGACY_WEBMCP_SETTINGS_KEY = 'skill-tree:webmcp-settings:v2';
const RELAY_VERSION = '5.0.1';
const RELAY_INVOKE_TIMEOUT_MS = '125000';
const BRIDGE_ALIAS = 'skill-tree-maker';
const SUGGESTED_DIR_NAME = 'SkillTreeMakerBridge';

type PlatformId = `${'windows' | 'darwin' | 'linux'}-${'amd64' | 'arm64'}`;
type PlatformOption = {
  id: PlatformId;
  label: string;
  assetName: string;
};
type ReleaseState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  tag: string;
  platforms: PlatformOption[];
  error: string | null;
};
type SavedSettings = { tunnelId: string; platform: string };
type GitHubRelease = {
  tag_name?: unknown;
  assets?: unknown;
};
type GitHubAsset = { name?: unknown };

let releaseState: ReleaseState = { status: 'idle', tag: '', platforms: [], error: null };
let saved = readSavedSettings();
let runtimeApiKey = '';
let notice = '';
let observer: MutationObserver | null = null;

function readSavedSettings(): SavedSettings {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<SavedSettings>;
    const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '';
    const platform = typeof value.platform === 'string' ? value.platform : '';
    if (tunnelId || platform) return { tunnelId, platform };
  } catch {
    // Fall back to the previous WebMCP tunnel setting.
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_WEBMCP_SETTINGS_KEY) ?? '') as { tunnelId?: unknown };
    return { tunnelId: typeof legacy.tunnelId === 'string' ? legacy.tunnelId.trim() : '', platform: '' };
  } catch {
    return { tunnelId: '', platform: '' };
  }
}

function persistSavedSettings(next: SavedSettings) {
  saved = next;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
}

function syncWebMcpTunnelId(tunnelId: string) {
  try {
    const current = JSON.parse(localStorage.getItem(LEGACY_WEBMCP_SETTINGS_KEY) ?? '{}') as Record<string, unknown>;
    localStorage.setItem(LEGACY_WEBMCP_SETTINGS_KEY, JSON.stringify({ ...current, tunnelId }));
  } catch {
    localStorage.setItem(LEGACY_WEBMCP_SETTINGS_KEY, JSON.stringify({ tunnelId }));
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function platformLabel(id: PlatformId) {
  const labels: Record<PlatformId, string> = {
    'windows-amd64': 'Windows x64 (Intel / AMD)',
    'windows-arm64': 'Windows ARM64',
    'darwin-arm64': 'macOS Apple Silicon',
    'darwin-amd64': 'macOS Intel',
    'linux-amd64': 'Linux x64 (Intel / AMD)',
    'linux-arm64': 'Linux ARM64',
  };
  return labels[id];
}

function platformSortValue(id: PlatformId) {
  const order: PlatformId[] = [
    'windows-amd64', 'windows-arm64', 'darwin-arm64', 'darwin-amd64', 'linux-amd64', 'linux-arm64',
  ];
  return order.indexOf(id);
}

function parsePlatforms(release: GitHubRelease) {
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!tag) throw new Error('GitHub did not return a tunnel-client release tag.');
  const assets = Array.isArray(release.assets) ? release.assets as GitHubAsset[] : [];
  const prefix = `tunnel-client-${tag}-`;
  const platforms: PlatformOption[] = [];
  for (const asset of assets) {
    const name = typeof asset.name === 'string' ? asset.name : '';
    if (!name.startsWith(prefix) || !name.endsWith('.zip')) continue;
    const platform = name.slice(prefix.length, -4);
    if (!/^(windows|darwin|linux)-(amd64|arm64)$/.test(platform)) continue;
    const id = platform as PlatformId;
    platforms.push({ id, label: platformLabel(id), assetName: name });
  }
  platforms.sort((a, b) => platformSortValue(a.id) - platformSortValue(b.id));
  if (!platforms.length) {
    throw new Error(`Release ${tag} did not contain any full-client tunnel-client-<version>-<platform>.zip packages.`);
  }
  return { tag, platforms };
}

async function refreshPlatforms(force = false) {
  if (releaseState.status === 'loading' || (!force && releaseState.status === 'ready')) return;
  releaseState = { status: 'loading', tag: releaseState.tag, platforms: releaseState.platforms, error: null };
  renderSetup();
  try {
    const response = await fetch(RELEASE_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
    const parsed = parsePlatforms(await response.json() as GitHubRelease);
    releaseState = { status: 'ready', tag: parsed.tag, platforms: parsed.platforms, error: null };
    if (!parsed.platforms.some((item) => item.id === saved.platform)) {
      persistSavedSettings({ ...saved, platform: '' });
    }
  } catch (error) {
    releaseState = {
      status: 'error',
      tag: '',
      platforms: [],
      error: error instanceof Error ? error.message : 'Could not load tunnel-client platforms from GitHub.',
    };
  }
  renderSetup();
}

function psSingleQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powerShellBody(platform: PlatformId, tunnelId: string, apiKey: string, origin: string) {
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

function windowsScript(platform: PlatformId, tunnelId: string, apiKey: string, origin: string) {
  const body = powerShellBody(platform, tunnelId, apiKey, origin).replace(/\r?\n/g, '\r\n');
  return `@echo off\r\nsetlocal\r\nset "STM_SCRIPT_PATH=%~f0"\r\nset "STM_PS_TEMP=%TEMP%\\skill-tree-maker-bridge-%RANDOM%-%RANDOM%.ps1"\r\npowershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:STM_SCRIPT_PATH; $raw=[IO.File]::ReadAllText($p); $m='#__POWERSHELL_BELOW__'; $i=$raw.IndexOf($m); if($i -lt 0){exit 1}; [IO.File]::WriteAllText($env:STM_PS_TEMP,$raw.Substring($i+$m.Length),[Text.UTF8Encoding]::new($false))"\r\nif errorlevel 1 (\r\n  echo Failed to prepare the embedded PowerShell launcher.\r\n  pause\r\n  exit /b 1\r\n)\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%STM_PS_TEMP%"\r\nset "STM_EXIT=%ERRORLEVEL%"\r\ndel "%STM_PS_TEMP%" >nul 2>&1\r\necho.\r\npause\r\nexit /b %STM_EXIT%\r\n#__POWERSHELL_BELOW__\r\n${body}`;
}

function bashScript(platform: PlatformId, tunnelId: string, apiKey: string, origin: string) {
  const os = platform.startsWith('darwin-') ? 'darwin' : 'linux';
  const arch = platform.endsWith('arm64') ? 'arm64' : 'x64';
  const nodeExt = os === 'darwin' ? 'tar.gz' : 'tar.xz';
  const nodeTarFlag = os === 'darwin' ? '-xzf' : '-xJf';
  return `#!/usr/bin/env bash
set -euo pipefail

TUNNEL_ID=${shellSingleQuote(tunnelId)}
RUNTIME_API_KEY=${shellSingleQuote(apiKey)}
PLATFORM=${shellSingleQuote(platform)}
WIDGET_ORIGIN=${shellSingleQuote(origin)}
RELAY_VERSION=${shellSingleQuote(RELAY_VERSION)}
RELAY_INVOKE_TIMEOUT=${shellSingleQuote(RELAY_INVOKE_TIMEOUT_MS)}
ALIAS=${shellSingleQuote(BRIDGE_ALIAS)}
RELEASE_API=${shellSingleQuote(RELEASE_API)}
SCRIPT_DIR="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$0" 2>/dev/null || true
TOOLS_DIR="$SCRIPT_DIR/tools"
TUNNEL_DIR="$TOOLS_DIR/tunnel-client"
NODE_DIR="$TOOLS_DIR/node"
mkdir -p "$TOOLS_DIR"

step() { printf '\\033[36m[Skill Tree Maker]\\033[0m %s\\n' "$1"; }
fail() { printf '\\033[31m[Skill Tree Maker] ERROR:\\033[0m %s\\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required to run this setup script."; }
need curl
need tar

step 'Checking the latest OpenAI tunnel-client release...'
release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: Skill-Tree-Maker-Bridge' "$RELEASE_API")"
if command -v python3 >/dev/null 2>&1; then
  tag="$(printf '%s' "$release_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"])')"
elif command -v perl >/dev/null 2>&1; then
  tag="$(printf '%s' "$release_json" | perl -ne 'print "$1\\n" if /"tag_name"\\s*:\\s*"([^"]+)"/; exit if $1')"
else
  fail 'python3 (preferred) or perl is required to parse the GitHub release response.'
fi
[ -n "$tag" ] || fail 'GitHub did not return a release tag.'
asset_name="tunnel-client-$tag-$PLATFORM.zip"
asset_url="https://github.com/openai/tunnel-client/releases/download/$tag/$asset_name"
sums_url="https://github.com/openai/tunnel-client/releases/download/$tag/SHA256SUMS.txt"

TUNNEL_EXE=""
if command -v tunnel-client >/dev/null 2>&1; then
  global_version="$(tunnel-client --version 2>&1 || true)"
  if printf '%s' "$global_version" | grep -Fq "$tag"; then
    TUNNEL_EXE="$(command -v tunnel-client)"
    step "Using existing tunnel-client $tag from PATH."
  fi
fi

version_file="$TUNNEL_DIR/.version"
if [ -z "$TUNNEL_EXE" ] && [ -f "$version_file" ] && [ "$(tr -d '\\r\\n' < "$version_file")" = "$tag" ]; then
  cached="$(find "$TUNNEL_DIR" -type f -name 'tunnel-client' -perm -u+x 2>/dev/null | head -n 1 || true)"
  if [ -n "$cached" ]; then
    TUNNEL_EXE="$cached"
    step "Using cached tunnel-client $tag."
  fi
fi

if [ -z "$TUNNEL_EXE" ]; then
  step "Installing/updating tunnel-client to $tag..."
  temp_zip="\${TMPDIR:-/tmp}/$asset_name"
  curl -fL "$asset_url" -o "$temp_zip"
  sums="$(curl -fsSL "$sums_url")"
  expected="$(printf '%s\\n' "$sums" | awk -v name="$asset_name" '$2==name || $2=="*"name {print $1; exit}')"
  [ -n "$expected" ] || fail "Could not find $asset_name in SHA256SUMS.txt."
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$temp_zip" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$temp_zip" | awk '{print $1}')"
  else
    fail 'sha256sum or shasum is required to verify the tunnel-client download.'
  fi
  [ "$actual" = "$expected" ] || fail 'The tunnel-client download failed SHA256 verification.'
  rm -rf "$TUNNEL_DIR"
  mkdir -p "$TUNNEL_DIR"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$temp_zip" -d "$TUNNEL_DIR"
  elif [ "$(uname -s)" = 'Darwin' ] && command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$temp_zip" "$TUNNEL_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -e "$temp_zip" "$TUNNEL_DIR"
  else
    fail 'unzip, ditto, or python3 is required to extract tunnel-client.'
  fi
  rm -f "$temp_zip"
  printf '%s' "$tag" > "$version_file"
  TUNNEL_EXE="$(find "$TUNNEL_DIR" -type f -name 'tunnel-client' | head -n 1 || true)"
  [ -n "$TUNNEL_EXE" ] || fail 'The tunnel-client archive did not contain a tunnel-client executable.'
  chmod +x "$TUNNEL_EXE"
fi

find_npx() {
  if command -v npx >/dev/null 2>&1; then command -v npx; return 0; fi
  find "$NODE_DIR" -type f -path '*/bin/npx' 2>/dev/null | head -n 1
}

NPX="$(find_npx || true)"
if [ -z "$NPX" ]; then
  step 'Node.js/npx was not found. Installing a portable Node.js LTS copy into this bridge folder...'
  node_version="$(curl -fsSL https://nodejs.org/dist/index.tab | awk -F '\\t' 'NR>1 && $10 != "-" {print $1; exit}')"
  [ -n "$node_version" ] || fail 'Could not determine the current Node.js LTS release.'
  node_asset="node-$node_version-${os}-${arch}.${nodeExt}"
  node_url="https://nodejs.org/dist/$node_version/$node_asset"
  node_archive="\${TMPDIR:-/tmp}/$node_asset"
  curl -fL "$node_url" -o "$node_archive"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar ${nodeTarFlag} "$node_archive" -C "$NODE_DIR"
  rm -f "$node_archive"
  NPX="$(find_npx || true)"
  [ -n "$NPX" ] || fail 'Portable Node.js installed, but npx could not be found.'
  chmod +x "$NPX"
  step "Installed portable Node.js $nodeVersion."
fi

export TUNNEL_RUNTIME_KEY="$RUNTIME_API_KEY"
relay_command="\\\"$NPX\\\" -y @mcp-b/webmcp-local-relay@$RELAY_VERSION --widget-origin $WIDGET_ORIGIN --invoke-timeout $RELAY_INVOKE_TIMEOUT"

step 'Starting or refreshing the managed Skill Tree Maker tunnel runtime...'
"$TUNNEL_EXE" runtimes connect --alias "$ALIAS" --tunnel-id "$TUNNEL_ID" --runtime-api-key env:TUNNEL_RUNTIME_KEY --mcp-command "$relay_command"

sleep 2
step 'Checking runtime status...'
"$TUNNEL_EXE" runtimes status "$ALIAS" --json

printf '\\n\\033[32mBridge startup completed. Keep the Skill Tree Maker browser tab open and enable the same tunnel in ChatGPT.\\033[0m\\n'
`;
}

function generateScript(platform: PlatformId, tunnelId: string, apiKey: string) {
  if (platform.startsWith('windows-')) {
    return { filename: 'Start-SkillTreeMaker-Bridge.cmd', content: windowsScript(platform, tunnelId, apiKey, window.location.origin) };
  }
  return { filename: 'start-skill-tree-maker-bridge.sh', content: bashScript(platform, tunnelId, apiKey, window.location.origin) };
}

function selectedPlatform() {
  const select = document.querySelector<HTMLSelectElement>('[data-bridge-platform]');
  return select?.value ?? saved.platform;
}

function currentTunnelId() {
  return document.querySelector<HTMLInputElement>('[data-bridge-tunnel-id]')?.value.trim() ?? saved.tunnelId;
}

function currentApiKey() {
  return document.querySelector<HTMLInputElement>('[data-bridge-api-key]')?.value ?? runtimeApiKey;
}

function downloadScript() {
  notice = '';
  const tunnelId = currentTunnelId();
  const apiKey = currentApiKey().trim();
  const platform = selectedPlatform();
  if (!/^tunnel_[0-9a-f]{32}$/.test(tunnelId)) {
    notice = 'Enter a valid tunnel ID (tunnel_ followed by 32 lowercase hexadecimal characters).';
    renderSetup();
    return;
  }
  if (!apiKey) {
    notice = 'Paste the restricted runtime API key. It is used only to generate the downloaded script and is not stored by this page.';
    renderSetup();
    return;
  }
  if (!releaseState.platforms.some((item) => item.id === platform)) {
    notice = 'Choose one of the tunnel-client platforms returned by the latest GitHub release.';
    renderSetup();
    return;
  }

  persistSavedSettings({ tunnelId, platform });
  syncWebMcpTunnelId(tunnelId);
  const generated = generateScript(platform as PlatformId, tunnelId, apiKey);
  try {
    const blob = new Blob([generated.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = generated.filename;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    notice = `Downloaded ${generated.filename}. Put it in a private folder of your choice before running it; the script will create its tools directory beside itself.`;
  } catch (error) {
    notice = error instanceof Error ? error.message : 'Could not download the launch script.';
  }
  renderSetup();
}

function platformOptionsHtml() {
  if (releaseState.status === 'loading' || releaseState.status === 'idle') return '<option value="">Loading platforms…</option>';
  if (releaseState.status === 'error') return '<option value="">Could not load platforms</option>';
  return `<option value="">Select a platform…</option>${releaseState.platforms.map((platform) =>
    `<option value="${platform.id}"${saved.platform === platform.id ? ' selected' : ''}>${escapeHtml(platform.label)}</option>`,
  ).join('')}`;
}

function setupMarkup() {
  const releaseNote = releaseState.status === 'ready'
    ? `Latest release: ${releaseState.tag}. The dropdown only includes exact full-client tunnel-client-${releaseState.tag}-&lt;platform&gt;.zip assets.`
    : releaseState.status === 'error'
      ? releaseState.error ?? 'Could not load the latest tunnel-client release.'
      : 'Loading the latest tunnel-client release from GitHub…';
  const scriptKind = saved.platform.startsWith('windows-') ? '.cmd' : saved.platform ? '.sh' : 'platform-specific';
  const launcherName = saved.platform.startsWith('windows-')
    ? 'Start-SkillTreeMaker-Bridge.cmd'
    : saved.platform ? 'start-skill-tree-maker-bridge.sh' : 'Choose a platform to see the launcher filename';
  return `
    <div class="webmcp-section-title"><strong>2. Create your one-file bridge launcher</strong><small>Provide the two OpenAI values, choose a release platform, and download a ${scriptKind} launcher. The API key is used only to build the file and is never written to browser storage.</small></div>
    <div class="bridge-setup-grid">
      <label class="webmcp-field"><span>Tunnel ID</span><input type="text" data-bridge-tunnel-id spellcheck="false" autocomplete="off" placeholder="tunnel_0123456789abcdef0123456789abcdef" value="${escapeHtml(saved.tunnelId)}"></label>
      <label class="webmcp-field"><span>Runtime API key</span><input type="password" data-bridge-api-key spellcheck="false" autocomplete="new-password" placeholder="Paste restricted Tunnels Read + Use key" value="${escapeHtml(runtimeApiKey)}"></label>
      <label class="webmcp-field"><span>Platform</span><select data-bridge-platform ${releaseState.status === 'ready' ? '' : 'disabled'}>${platformOptionsHtml()}</select></label>
    </div>
    <div class="bridge-release-note${releaseState.status === 'error' ? ' is-error' : ''}">${releaseNote}</div>
    <div class="webmcp-actions">
      <button type="button" data-bridge-action="refresh-platforms">Refresh platforms</button>
      <a href="${TUNNELS_URL}" target="_blank" rel="noreferrer">Open Tunnels</a>
      <a href="${API_KEYS_URL}" target="_blank" rel="noreferrer">Runtime API keys</a>
    </div>
    <div class="bridge-script-card">
      <div class="bridge-script-name"><span>Launcher file</span><code>${escapeHtml(launcherName)}</code></div>
      <strong>What the generated launcher does</strong>
      <ol class="webmcp-steps">
        <li>Creates and uses a private <code>tools</code> directory beside itself.</li>
        <li>Queries <code>openai/tunnel-client/releases/latest</code> every run, uses only the exact full-client ZIP for your selected platform, and installs/updates its local copy when necessary. Existing up-to-date <code>tunnel-client</code> on PATH is reused.</li>
        <li>Verifies the tunnel-client ZIP against the release <code>SHA256SUMS.txt</code>.</li>
        <li>Uses your existing <code>npx</code>, or automatically downloads a portable current Node.js LTS copy into the same folder if Node is not installed.</li>
        <li>Starts <code>@mcp-b/webmcp-local-relay@${RELAY_VERSION}</code> through <code>tunnel-client runtimes connect</code>, then automatically runs <code>runtimes status ${BRIDGE_ALIAS} --json</code>.</li>
      </ol>
      <button type="button" class="bridge-primary-action" data-bridge-action="download-script" ${releaseState.status === 'ready' ? '' : 'disabled'}>Download launcher script</button>
      <small class="webmcp-note">The browser downloads only <code>${escapeHtml(launcherName)}</code>; it does not create or write any folder. Put the file in a private folder of your choice (for example <code>${SUGGESTED_DIR_NAME}</code>) before running it. The launcher contains your API key in plain text as requested, so never share it.${saved.platform.startsWith('darwin-') || saved.platform.startsWith('linux-') ? ' The first time, run it with <code>bash ./start-skill-tree-maker-bridge.sh</code>; it marks itself executable so later runs can use <code>./start-skill-tree-maker-bridge.sh</code>.' : ''}</small>
    </div>
    ${notice ? `<div class="bridge-setup-notice">${escapeHtml(notice)}</div>` : ''}
    <div class="webmcp-actions"><a href="${CHATGPT_CONNECTORS_URL}" target="_blank" rel="noreferrer">Open ChatGPT Connectors</a></div>`;
}

function findLegacySection(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(':scope > .webmcp-section')).find((section) =>
    section.querySelector('.webmcp-section-title strong')?.textContent?.trim() === '2. Connect your OpenAI tunnel',
  ) ?? null;
}

function ensureSetupSection() {
  const panel = document.querySelector<HTMLElement>('.webmcp-panel');
  if (!panel) return;

  let section = panel.querySelector<HTMLElement>(':scope > .bridge-launch-section');
  const legacy = findLegacySection(panel);
  if (legacy) {
    if (!section) {
      section = document.createElement('div');
      section.className = 'webmcp-section bridge-launch-section';
      section.innerHTML = setupMarkup();
      legacy.replaceWith(section);
      void refreshPlatforms();
    } else {
      legacy.remove();
    }
    return;
  }

  if (section && !section.innerHTML) section.innerHTML = setupMarkup();
}

function renderSetup() {
  ensureSetupSection();
  const section = document.querySelector<HTMLElement>('.bridge-launch-section');
  if (section) section.innerHTML = setupMarkup();
}

function installHandlers() {
  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.matches('[data-bridge-api-key]')) {
      runtimeApiKey = target.value;
    } else if (target.matches('[data-bridge-tunnel-id]')) {
      saved = { ...saved, tunnelId: target.value };
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches('[data-bridge-platform]')) return;
    persistSavedSettings({ ...saved, platform: target.value });
    renderSetup();
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>('[data-bridge-action]')?.dataset.bridgeAction;
    if (action === 'refresh-platforms') void refreshPlatforms(true);
    if (action === 'download-script') downloadScript();
  });
}

function startObserver() {
  ensureSetupSection();
  observer = new MutationObserver(() => ensureSetupSection());
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

installHandlers();
startObserver();