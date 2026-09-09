const FALLBACK_PROJECT_NAME = 'Skill Tree';

function currentProjectLabel() {
  return document.querySelector<HTMLElement>('.project-manager-button-label');
}

function currentRenameButton() {
  return document.querySelector<HTMLButtonElement>(
    '.project-manager-row.is-selected [data-project-action="rename"]',
  );
}

function openProjectManager() {
  document.querySelector<HTMLButtonElement>('.project-manager-button')?.click();
}

function installBrandRuntime() {
  const heading = document.querySelector<HTMLElement>('.brand-block h1');
  if (!heading) return false;

  const projectLabel = currentProjectLabel();
  const syncProjectName = () => {
    const name = projectLabel?.textContent?.trim();
    heading.dataset.projectName = name || FALLBACK_PROJECT_NAME;
  };

  if (heading.dataset.brandRuntimeInstalled !== 'true') {
    heading.dataset.brandRuntimeInstalled = 'true';
    heading.dataset.projectName = FALLBACK_PROJECT_NAME;
    heading.setAttribute('role', 'button');
    heading.setAttribute('tabindex', '0');
    heading.setAttribute('title', 'Rename project');

    const renameProject = () => {
      const renameButton = currentRenameButton();
      if (renameButton) renameButton.click();
      else openProjectManager();
    };

    heading.addEventListener('click', renameProject);
    heading.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      renameProject();
    });
  }

  syncProjectName();

  if (projectLabel && projectLabel.dataset.brandRuntimeObserved !== 'true') {
    projectLabel.dataset.brandRuntimeObserved = 'true';
    new MutationObserver(syncProjectName).observe(projectLabel, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  return Boolean(projectLabel);
}

if (!installBrandRuntime()) {
  const observer = new MutationObserver(() => {
    if (installBrandRuntime()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
