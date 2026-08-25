import './webMcpEnvironmentSetup.css';

type PlatformId = 'windows-cmd' | 'powershell' | 'macos' | 'linux-bash' | 'linux-zsh';

type PlatformOption = {
  id: PlatformId;
  label: string;
  detail: string;
};

const PLATFORM_OPTIONS: PlatformOption[] = [
  { id: 'windows-cmd', label: 'Windows CMD', detail: 'Command Prompt' },
  { id: 'powershell', label: 'PowerShell', detail: 'Windows PowerShell / pwsh' },
  { id: 'macos', label: 'macOS', detail: 'zsh (default)' },
  { id: 'linux-bash', label: 'Linux Bash', detail: '~/.bashrc' },
  { id: 'linux-zsh', label: 'Linux Zsh', detail: '~/.zshrc' },
];

const API_KEY_PLACEHOLDER = '<PASTE_RUNTIME_API_KEY_ABOVE>';

let runtimeApiKey = '';
let selectedPlatform: PlatformId = detectPlatform();
let enhanceScheduled = false;

function detectPlatform(): PlatformId {
  const hint = `${navigator.userAgent} ${navigator.platform}`.toLocaleLowerCase();
  if (hint.includes('win')) return 'powershell';
  if (hint.includes('mac')) return 'macos';
  return 'linux-bash';
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]!);
}

function powerShellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function posixDoubleQuote(value: string) {
  return `"${value.replace(/[\\$"`]/g, '\\$&')}"`;
}

function posixSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runtimeKeyValue() {
  return runtimeApiKey.trim() || API_KEY_PLACEHOLDER;
}

function environmentCommand(platform: PlatformId) {
  const key = runtimeKeyValue();
  if (platform === 'windows-cmd') {
    return `set "TUNNEL_RUNTIME_KEY=${key}" && setx TUNNEL_RUNTIME_KEY "${key}" >nul`;
  }
  if (platform === 'powershell') {
    const quoted = powerShellQuote(key);
    return `$env:TUNNEL_RUNTIME_KEY = ${quoted}; [Environment]::SetEnvironmentVariable('TUNNEL_RUNTIME_KEY', ${quoted}, 'User')`;
  }

  const quoted = posixDoubleQuote(key);
  const exportLine = `export TUNNEL_RUNTIME_KEY=${quoted}`;
  const profile = platform === 'linux-bash' ? '~/.bashrc' : '~/.zshrc';
  return `printf '%s\\n' ${posixSingleQuote(exportLine)} >> ${profile} && ${exportLine}`;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

function platformTabs() {
  return PLATFORM_OPTIONS.map((option) => `
    <button type="button" role="tab" data-webmcp-platform="${option.id}" aria-selected="${option.id === selectedPlatform ? 'true' : 'false'}" class="${option.id === selectedPlatform ? 'is-active' : ''}">
      <strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.detail)}</small>
    </button>`).join('');
}

function setupMarkup() {
  return `
    <div class="webmcp-runtime-key-setup" data-webmcp-runtime-key-setup>
      <div class="webmcp-command-label"><strong>Set your runtime API key</strong><small>Used only to generate the command below. Skill Tree Maker never writes this key to localStorage, sessionStorage, IndexedDB, or project data.</small></div>
      <label class="webmcp-field webmcp-secret-field">
        <span>Runtime API key</span>
        <div class="webmcp-secret-input-row">
          <input type="password" data-webmcp-runtime-key autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-...">
          <button type="button" data-webmcp-env-action="toggle-secret" aria-pressed="false">Show</button>
          <button type="button" data-webmcp-env-action="clear-secret">Clear</button>
        </div>
      </label>
      <div class="webmcp-platform-picker">
        <div class="webmcp-command-label"><strong>Choose your terminal</strong><small>The command sets the variable for the current terminal and persists it for future terminals for your user account.</small></div>
        <div class="webmcp-platform-tabs" role="tablist" aria-label="Operating system and terminal">${platformTabs()}</div>
      </div>
      <div class="webmcp-command-label"><strong>1. Set the permanent environment variable</strong><small>Copy and run this first.</small></div>
      <div class="webmcp-command webmcp-env-command"><code data-webmcp-env-command>${escapeHtml(environmentCommand(selectedPlatform))}</code><button type="button" data-webmcp-env-action="copy-env" disabled>Copy</button></div>
      <small class="webmcp-note webmcp-secret-note">The page keeps the key only in this tab's JavaScript memory until reload. The copied command contains the secret, so your clipboard and terminal history may retain it.</small>
    </div>`;
}

function updateSetupUi(section: HTMLElement) {
  const input = section.querySelector<HTMLInputElement>('[data-webmcp-runtime-key]');
  if (input && input.value !== runtimeApiKey) input.value = runtimeApiKey;

  section.querySelectorAll<HTMLButtonElement>('[data-webmcp-platform]').forEach((button) => {
    const active = button.dataset.webmcpPlatform === selectedPlatform;
    if (button.classList.contains('is-active') !== active) button.classList.toggle('is-active', active);
    const ariaSelected = active ? 'true' : 'false';
    if (button.getAttribute('aria-selected') !== ariaSelected) button.setAttribute('aria-selected', ariaSelected);
  });

  const code = section.querySelector<HTMLElement>('[data-webmcp-env-command]');
  const nextCommand = environmentCommand(selectedPlatform);
  if (code && code.textContent !== nextCommand) code.textContent = nextCommand;

  const copyButton = section.querySelector<HTMLButtonElement>('[data-webmcp-env-action="copy-env"]');
  if (copyButton) copyButton.disabled = !runtimeApiKey.trim();
}

function patchInstructions(section: HTMLElement) {
  if (section.dataset.runtimeKeyPatched === 'true') return;
  section.dataset.runtimeKeyPatched = 'true';

  const titleNote = section.querySelector<HTMLElement>('.webmcp-section-title small');
  if (titleNote) {
    titleNote.textContent = 'Enter the runtime API key here only long enough to generate your platform command. The app does not persist it.';
  }

  const steps = section.querySelectorAll<HTMLElement>('.webmcp-steps > li');
  if (steps[1]) {
    steps[1].innerHTML = 'Create a restricted OpenAI runtime API key with <code>Tunnels Read + Use</code> permissions, then paste it into the temporary field below.';
  }
  if (steps[2]) {
    steps[2].innerHTML = 'Run the generated environment-variable command first, then paste the non-secret tunnel ID and run the tunnel-client command.';
  }

  const tunnelField = section.querySelector<HTMLElement>('[data-webmcp-tunnel-id]')?.closest('.webmcp-field');
  if (tunnelField && !section.querySelector('[data-webmcp-runtime-key-setup]')) {
    tunnelField.insertAdjacentHTML('beforebegin', setupMarkup());
  }

  const commands = Array.from(section.querySelectorAll<HTMLElement>(':scope > .webmcp-command'));
  const tunnelCommand = commands[0];
  if (tunnelCommand && !section.querySelector('[data-webmcp-tunnel-command-label]')) {
    const label = document.createElement('div');
    label.className = 'webmcp-command-label';
    label.dataset.webmcpTunnelCommandLabel = 'true';
    label.innerHTML = '<strong>2. Run tunnel-client</strong><small>Run this in the same terminal after setting the environment variable above.</small>';
    tunnelCommand.insertAdjacentElement('beforebegin', label);
  }

  section.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (!target.matches('[data-webmcp-runtime-key]')) return;
    runtimeApiKey = target.value;
    updateSetupUi(section);
  });

  section.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const platformButton = target.closest<HTMLButtonElement>('[data-webmcp-platform]');
    if (platformButton?.dataset.webmcpPlatform) {
      selectedPlatform = platformButton.dataset.webmcpPlatform as PlatformId;
      updateSetupUi(section);
      return;
    }

    const action = target.closest<HTMLButtonElement>('[data-webmcp-env-action]')?.dataset.webmcpEnvAction;
    if (action === 'copy-env') {
      if (runtimeApiKey.trim()) void copyText(environmentCommand(selectedPlatform));
    } else if (action === 'toggle-secret') {
      const input = section.querySelector<HTMLInputElement>('[data-webmcp-runtime-key]');
      const button = target.closest<HTMLButtonElement>('[data-webmcp-env-action="toggle-secret"]');
      if (!input || !button) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? 'Hide' : 'Show';
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
    } else if (action === 'clear-secret') {
      runtimeApiKey = '';
      const input = section.querySelector<HTMLInputElement>('[data-webmcp-runtime-key]');
      if (input) input.value = '';
      updateSetupUi(section);
    }
  });
}

function enhancePanel() {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('.webmcp-panel .webmcp-section'));
  const section = sections.find((candidate) => candidate.querySelector('.webmcp-section-title strong')?.textContent?.includes('Connect your OpenAI tunnel'));
  if (!section) return;

  patchInstructions(section);
  updateSetupUi(section);
}

function scheduleEnhance() {
  if (enhanceScheduled) return;
  enhanceScheduled = true;
  queueMicrotask(() => {
    enhanceScheduled = false;
    enhancePanel();
  });
}

const observer = new MutationObserver(scheduleEnhance);
observer.observe(document.documentElement, { childList: true, subtree: true });
scheduleEnhance();
