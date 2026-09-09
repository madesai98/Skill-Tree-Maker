const MOBILE_BREAKPOINT = 760;

type ModalDefinition = {
  panelSelector: string;
  triggerSelector: string;
  closeSelector?: string;
  label: string;
};

const MODALS: ModalDefinition[] = [
  {
    panelSelector: '.webmcp-panel',
    triggerSelector: '.webmcp-button',
    closeSelector: '[data-mcp-action="close"]',
    label: 'MCP settings',
  },
  {
    panelSelector: '.project-manager-panel',
    triggerSelector: '.project-manager-button',
    closeSelector: '[data-project-action="close"]',
    label: 'Project manager',
  },
  {
    panelSelector: '.history-panel',
    triggerSelector: '.history-button',
    label: 'Change history',
  },
];

let installed = false;
let settingsOpen = false;
let viewMenuOpen = false;
let activeModal: HTMLElement | null = null;
let settingsButton: HTMLButtonElement | null = null;
let viewMenuButton: HTMLButtonElement | null = null;
let settingsPanel: HTMLElement | null = null;
let topbar: HTMLElement | null = null;

function setText(root: ParentNode, selector: string, value: string) {
  const element = root.querySelector<HTMLElement>(selector);
  if (element && element.textContent !== value) element.textContent = value;
}

function modalPanel(definition: ModalDefinition) {
  return document.querySelector<HTMLElement>(definition.panelSelector);
}

function modalTrigger(definition: ModalDefinition) {
  return document.querySelector<HTMLButtonElement>(definition.triggerSelector);
}

function closeModal(definition: ModalDefinition) {
  const panel = modalPanel(definition);
  if (!panel || panel.hidden) return;
  const closeButton = definition.closeSelector
    ? panel.querySelector<HTMLButtonElement>(definition.closeSelector)
    : null;
  if (closeButton) closeButton.click();
  else modalTrigger(definition)?.click();
}

function closeAllModals(exceptSelector?: string) {
  for (const definition of MODALS) {
    if (definition.panelSelector === exceptSelector) continue;
    closeModal(definition);
  }
}

function ensureHistoryCloseButton() {
  const panel = document.querySelector<HTMLElement>('.history-panel');
  const head = panel?.querySelector<HTMLElement>('.history-panel-head');
  if (!head || head.querySelector('.app-history-modal-close')) return;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'app-history-modal-close';
  closeButton.setAttribute('aria-label', 'Close history');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    document.querySelector<HTMLButtonElement>('.history-button')?.click();
  });
  head.appendChild(closeButton);
}

function syncModalState(backdrop: HTMLElement) {
  ensureHistoryCloseButton();

  let visible: HTMLElement | null = null;
  for (const definition of MODALS) {
    const panel = modalPanel(definition);
    if (!panel) continue;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', definition.label);
    panel.tabIndex = -1;
    if (!panel.hidden && !visible) visible = panel;
  }

  backdrop.hidden = !visible;
  document.body.classList.toggle('app-modal-visible', Boolean(visible));

  if (visible !== activeModal) {
    activeModal = visible;
    if (visible) {
      window.requestAnimationFrame(() => {
        if (activeModal === visible) visible.focus({ preventScroll: true });
      });
    } else {
      settingsButton?.focus({ preventScroll: true });
    }
  }
}

function normalizeViewButtons(nav: HTMLElement) {
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
    const label = button.dataset.viewLabel
      || button.textContent?.replace(/\s+/g, ' ').trim()
      || button.getAttribute('aria-label')
      || 'View';
    button.dataset.viewLabel = label;
    if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', label);
  });
}

function setSettingsOpen(open: boolean) {
  settingsOpen = open;
  if (!settingsPanel || !settingsButton) return;
  settingsPanel.hidden = !open;
  settingsButton.setAttribute('aria-expanded', String(open));
  if (open) setViewMenuOpen(false);
}

function setViewMenuOpen(open: boolean) {
  viewMenuOpen = open && window.innerWidth <= MOBILE_BREAKPOINT;
  topbar?.classList.toggle('is-view-menu-open', viewMenuOpen);
  viewMenuButton?.setAttribute('aria-expanded', String(viewMenuOpen));
  if (viewMenuOpen) setSettingsOpen(false);
}

function syncSettingsSummary(panel: HTMLElement) {
  const mcpStatus = document.querySelector<HTMLElement>('.webmcp-button-status')?.textContent?.trim() || 'Off';
  const projectName = document.querySelector<HTMLElement>('.project-manager-button-label')?.textContent?.trim() || 'Projects';
  const projectStatus = document.querySelector<HTMLElement>('.project-manager-status')?.textContent?.trim() || 'Local';
  const savedAt = document.querySelector<HTMLElement>('.top-actions > .save-status')?.textContent?.trim() || 'Saved';

  setText(panel, '[data-settings-value="mcp-status"]', mcpStatus);
  setText(panel, '[data-settings-value="project-name"]', projectName);
  setText(panel, '[data-settings-value="project-status"]', projectStatus);
  setText(panel, '[data-settings-value="saved-at"]', savedAt);
}

function iconMarkup(name: 'settings' | 'menu' | 'project' | 'history' | 'upload' | 'download') {
  if (name === 'settings') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .55 1.7 1.7 0 0 0-.43 1.12V21h-4v-.08A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.55-1 1.7 1.7 0 0 0-1.12-.43H3v-4h.08A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.55 1.7 1.7 0 0 0 .43-1.12V3h4v.08A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.1.37.3.72.55 1 .29.3.68.45 1.12.43H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"></path></svg>';
  }
  if (name === 'menu') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>';
  }
  if (name === 'project') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"></path><path d="M3.5 9h17"></path></svg>';
  }
  if (name === 'history') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.7"></path><path d="M4 4v4.7h4.7"></path><path d="M12 8v4l2.7 1.7"></path></svg>';
  }
  if (name === 'upload') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"></path><path d="M5 14v5h14v-5"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5"></path><path d="M5 19h14"></path></svg>';
}

function installChrome() {
  if (installed) return true;

  const shellTopbar = document.querySelector<HTMLElement>('.topbar');
  const actions = document.querySelector<HTMLElement>('.top-actions');
  const nav = document.querySelector<HTMLElement>('.view-switcher');
  const hasRuntimeControls = actions?.querySelector('.webmcp-control')
    && actions.querySelector('.project-manager-control')
    && actions.querySelector('.history-control');
  const hasSolver = nav?.querySelector('.solver-tab-button');
  if (!shellTopbar || !actions || !nav || !hasRuntimeControls || !hasSolver) return false;

  const importButton = Array.from(actions.querySelectorAll<HTMLButtonElement>(':scope > button.icon-button.labeled'))
    .find((button) => button.textContent?.includes('Import'));
  const exportButton = Array.from(actions.querySelectorAll<HTMLButtonElement>(':scope > button.icon-button.labeled'))
    .find((button) => button.textContent?.includes('Export'));
  if (!importButton || !exportButton) return false;

  installed = true;
  topbar = shellTopbar;
  normalizeViewButtons(nav);

  viewMenuButton = document.createElement('button');
  viewMenuButton.type = 'button';
  viewMenuButton.className = 'app-view-menu-button';
  viewMenuButton.setAttribute('aria-label', 'Open view menu');
  viewMenuButton.setAttribute('aria-expanded', 'false');
  viewMenuButton.innerHTML = iconMarkup('menu');

  const settingsControl = document.createElement('div');
  settingsControl.className = 'app-settings-control';
  settingsControl.innerHTML = `
    <button type="button" class="app-settings-button" aria-label="Workspace settings" aria-expanded="false">${iconMarkup('settings')}</button>
    <div class="app-settings-panel" hidden>
      <div class="app-settings-head"><strong>Workspace</strong><small>Project, history, MCP and files</small></div>
      <button type="button" class="app-settings-entry" data-settings-target="mcp">
        <span class="app-settings-entry-icon">⌁</span>
        <span class="app-settings-entry-copy"><strong>MCP</strong><small data-settings-value="mcp-status">Off</small></span>
        <span class="app-settings-chevron">›</span>
      </button>
      <button type="button" class="app-settings-entry" data-settings-target="project">
        <span class="app-settings-entry-icon app-settings-entry-svg">${iconMarkup('project')}</span>
        <span class="app-settings-entry-copy"><strong data-settings-value="project-name">Projects</strong><small data-settings-value="project-status">Local</small></span>
        <span class="app-settings-chevron">›</span>
      </button>
      <button type="button" class="app-settings-entry" data-settings-target="history">
        <span class="app-settings-entry-icon app-settings-entry-svg">${iconMarkup('history')}</span>
        <span class="app-settings-entry-copy"><strong>History</strong><small>Undo, redo and change log</small></span>
        <span class="app-settings-chevron">›</span>
      </button>
      <div class="app-settings-save"><i></i><span data-settings-value="saved-at">Saved</span></div>
      <div class="app-settings-file-actions">
        <button type="button" data-settings-target="import">${iconMarkup('upload')}<span>Import</span></button>
        <button type="button" data-settings-target="export">${iconMarkup('download')}<span>Export</span></button>
      </div>
    </div>`;

  settingsButton = settingsControl.querySelector<HTMLButtonElement>('.app-settings-button');
  settingsPanel = settingsControl.querySelector<HTMLElement>('.app-settings-panel');
  if (!settingsButton || !settingsPanel) return false;

  actions.append(viewMenuButton, settingsControl);

  const backdrop = document.createElement('div');
  backdrop.className = 'app-modal-backdrop';
  backdrop.hidden = true;
  document.body.appendChild(backdrop);

  document.body.classList.add('app-chrome-ready');
  syncSettingsSummary(settingsPanel);
  syncModalState(backdrop);

  viewMenuButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeAllModals();
    setViewMenuOpen(!viewMenuOpen);
  });

  settingsButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!settingsOpen) closeAllModals();
    syncSettingsSummary(settingsPanel!);
    setSettingsOpen(!settingsOpen);
  });

  settingsPanel.addEventListener('click', (event) => {
    event.stopPropagation();
    const target = event.target as Element;
    const button = target.closest<HTMLButtonElement>('[data-settings-target]');
    if (!button) return;

    const action = button.dataset.settingsTarget;
    if (action === 'mcp') {
      closeAllModals('.webmcp-panel');
      modalTrigger(MODALS[0])?.click();
    } else if (action === 'project') {
      closeAllModals('.project-manager-panel');
      modalTrigger(MODALS[1])?.click();
    } else if (action === 'history') {
      closeAllModals('.history-panel');
      modalTrigger(MODALS[2])?.click();
    } else if (action === 'import') {
      importButton.click();
    } else if (action === 'export') {
      exportButton.click();
    }
    setSettingsOpen(false);
  });

  nav.addEventListener('click', () => {
    setViewMenuOpen(false);
    setSettingsOpen(false);
  });

  backdrop.addEventListener('click', () => closeAllModals());

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (settingsOpen && !settingsControl.contains(target)) setSettingsOpen(false);
    if (viewMenuOpen && !nav.contains(target) && !viewMenuButton?.contains(target)) setViewMenuOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (settingsOpen) {
      setSettingsOpen(false);
      settingsButton?.focus();
      return;
    }
    if (viewMenuOpen) {
      setViewMenuOpen(false);
      viewMenuButton?.focus();
      return;
    }
    if (activeModal) closeAllModals();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > MOBILE_BREAKPOINT && viewMenuOpen) setViewMenuOpen(false);
  });

  new MutationObserver(() => normalizeViewButtons(nav)).observe(nav, { childList: true, subtree: true });

  new MutationObserver((mutations) => {
    const externalMutation = mutations.some((mutation) => {
      const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      return !element?.closest('.app-settings-control');
    });
    if (externalMutation && settingsPanel) syncSettingsSummary(settingsPanel);
  }).observe(actions, { childList: true, subtree: true, characterData: true });

  const modalObserver = new MutationObserver(() => syncModalState(backdrop));
  for (const definition of MODALS) {
    const panel = modalPanel(definition);
    if (panel) modalObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
  }

  return true;
}

if (!installChrome()) {
  const observer = new MutationObserver(() => {
    if (installChrome()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
