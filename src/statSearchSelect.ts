import './statSearchSelect.css';

const STORAGE_KEY = 'incremental-td-skill-tree:v2';
const ENHANCED_ATTR = 'data-fuzzy-stat-select';

type StoredStat = {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  groupName?: unknown;
};

type SearchOption = {
  id: string;
  name: string;
  groupName: string;
  gameKey: string;
  option: HTMLOptionElement;
};

type SearchGroup = {
  name: string;
  options: SearchOption[];
};

function readStatMetadata() {
  const metadata = new Map<string, { key: string; groupName: string }>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return metadata;
    const project = JSON.parse(raw) as { stats?: unknown };
    if (!Array.isArray(project.stats)) return metadata;
    project.stats.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const stat = item as StoredStat;
      if (typeof stat.id !== 'string') return;
      metadata.set(stat.id, {
        key: typeof stat.key === 'string' ? stat.key : '',
        groupName: typeof stat.groupName === 'string' ? stat.groupName : '',
      });
    });
  } catch {
    // Search can still use the option and optgroup labels if storage is unavailable.
  }
  return metadata;
}

function selectedDisplay(select: HTMLSelectElement) {
  const option = select.selectedOptions[0];
  if (!option) return '';
  const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label.trim() : '';
  return group ? `${group} ${option.textContent?.trim() ?? ''}`.trim() : option.textContent?.trim() ?? '';
}

function normalized(value: string) {
  return value.toLocaleLowerCase().trim();
}

function fuzzyTokenMatches(token: string, candidate: string) {
  if (!token) return true;
  if (candidate.includes(token)) return true;
  let tokenIndex = 0;
  for (let index = 0; index < candidate.length && tokenIndex < token.length; index += 1) {
    if (candidate[index] === token[tokenIndex]) tokenIndex += 1;
  }
  return tokenIndex === token.length;
}

function fuzzyMatches(query: string, option: SearchOption) {
  const tokens = normalized(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const fields = [option.name, option.groupName, option.gameKey].map(normalized);
  const combined = normalized(`${option.groupName} ${option.name} ${option.gameKey}`);
  return tokens.every((token) => fields.some((field) => fuzzyTokenMatches(token, field)) || fuzzyTokenMatches(token, combined));
}

function nativeSetSelectValue(select: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (valueSetter) valueSetter.call(select, value);
  else select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function collectGroups(select: HTMLSelectElement, query: string) {
  const metadata = readStatMetadata();
  const groups: SearchGroup[] = [];

  Array.from(select.children).forEach((child) => {
    if (child instanceof HTMLOptGroupElement) {
      const options = Array.from(child.querySelectorAll('option')).flatMap<SearchOption>((option) => {
        const id = option.value;
        const meta = metadata.get(id);
        const item: SearchOption = {
          id,
          name: option.textContent?.trim() ?? '',
          groupName: child.label.trim() || meta?.groupName || '',
          gameKey: meta?.key ?? '',
          option,
        };
        return fuzzyMatches(query, item) ? [item] : [];
      });
      if (options.length) groups.push({ name: child.label.trim(), options });
      return;
    }

    if (child instanceof HTMLOptionElement) {
      const meta = metadata.get(child.value);
      const item: SearchOption = {
        id: child.value,
        name: child.textContent?.trim() ?? '',
        groupName: meta?.groupName ?? '',
        gameKey: meta?.key ?? '',
        option: child,
      };
      if (fuzzyMatches(query, item)) groups.push({ name: item.groupName, options: [item] });
    }
  });

  return groups;
}

function isStatSelect(select: HTMLSelectElement) {
  const label = select.closest('label.field-label.compact');
  if (!label) return false;
  const ownText = Array.from(label.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .trim();
  return /^stat\b/i.test(ownText);
}

function enhanceStatSelect(select: HTMLSelectElement) {
  if (select.hasAttribute(ENHANCED_ATTR) || !isStatSelect(select)) return;
  select.setAttribute(ENHANCED_ATTR, 'true');
  select.classList.add('fuzzy-stat-native-select');

  const field = document.createElement('div');
  field.className = 'fuzzy-stat-field';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fuzzy-stat-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  const chevron = document.createElement('span');
  chevron.className = 'fuzzy-stat-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  field.append(input, chevron);
  select.insertAdjacentElement('afterend', field);

  const menu = document.createElement('div');
  menu.className = 'fuzzy-stat-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  document.body.append(menu);

  let searching = false;
  let activeIndex = -1;
  let flatOptions: SearchOption[] = [];

  const syncDisplay = () => {
    if (!searching) input.value = selectedDisplay(select);
  };

  const positionMenu = () => {
    if (menu.hidden || !field.isConnected) return;
    const rect = field.getBoundingClientRect();
    const viewportPadding = 8;
    const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
    const availableAbove = rect.top - viewportPadding;
    const desiredHeight = Math.min(320, Math.max(160, menu.scrollHeight));
    const openAbove = availableBelow < Math.min(220, desiredHeight) && availableAbove > availableBelow;
    const maxHeight = Math.max(120, Math.min(320, openAbove ? availableAbove - 6 : availableBelow - 6));
    menu.style.left = `${Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding))}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    if (openAbove) {
      menu.style.top = 'auto';
      menu.style.bottom = `${window.innerHeight - rect.top + 5}px`;
    } else {
      menu.style.bottom = 'auto';
      menu.style.top = `${rect.bottom + 5}px`;
    }
  };

  const setActive = (index: number) => {
    if (!flatOptions.length) {
      activeIndex = -1;
      return;
    }
    activeIndex = Math.max(0, Math.min(index, flatOptions.length - 1));
    menu.querySelectorAll<HTMLElement>('.fuzzy-stat-option').forEach((element, elementIndex) => {
      const active = elementIndex === activeIndex;
      element.classList.toggle('is-active', active);
      if (active) element.scrollIntoView({ block: 'nearest' });
    });
  };

  const choose = (item: SearchOption) => {
    searching = false;
    nativeSetSelectValue(select, item.id);
    input.value = `${item.groupName} ${item.name}`.trim();
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    input.blur();
  };

  const renderMenu = (query = '') => {
    const groups = collectGroups(select, query);
    flatOptions = groups.flatMap((group) => group.options);
    menu.replaceChildren();

    if (!flatOptions.length) {
      const empty = document.createElement('div');
      empty.className = 'fuzzy-stat-empty';
      empty.textContent = 'No matching stats';
      menu.append(empty);
      activeIndex = -1;
    } else {
      groups.forEach((group) => {
        if (group.name) {
          const heading = document.createElement('div');
          heading.className = 'fuzzy-stat-group';
          heading.textContent = group.name;
          menu.append(heading);
        }
        group.options.forEach((item) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'fuzzy-stat-option';
          option.setAttribute('role', 'option');
          option.dataset.statId = item.id;

          const name = document.createElement('span');
          name.className = 'fuzzy-stat-option-name';
          name.textContent = item.name;
          option.append(name);

          if (item.gameKey) {
            const key = document.createElement('span');
            key.className = 'fuzzy-stat-option-key';
            key.textContent = item.gameKey;
            option.append(key);
          }

          option.addEventListener('mousedown', (event) => event.preventDefault());
          option.addEventListener('click', () => choose(item));
          menu.append(option);
        });
      });
      const selectedIndex = flatOptions.findIndex((item) => item.id === select.value);
      setActive(selectedIndex >= 0 ? selectedIndex : 0);
    }

    requestAnimationFrame(positionMenu);
  };

  const openMenu = () => {
    if (!field.isConnected || !select.isConnected) return;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    renderMenu(searching ? input.value : '');
    positionMenu();
  };

  const closeMenu = (restore = true) => {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
    if (restore) {
      searching = false;
      syncDisplay();
    }
  };

  input.addEventListener('focus', () => {
    searching = false;
    syncDisplay();
    openMenu();
    requestAnimationFrame(() => input.select());
  });

  input.addEventListener('click', () => {
    if (menu.hidden) openMenu();
  });

  input.addEventListener('input', () => {
    searching = true;
    openMenu();
    renderMenu(input.value);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (menu.hidden) openMenu();
      setActive(activeIndex < 0 ? 0 : activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (menu.hidden) openMenu();
      setActive(activeIndex < 0 ? flatOptions.length - 1 : activeIndex - 1);
    } else if (event.key === 'Enter' && !menu.hidden && activeIndex >= 0) {
      event.preventDefault();
      choose(flatOptions[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      input.blur();
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => closeMenu(true), 0);
  });

  select.addEventListener('change', () => {
    searching = false;
    syncDisplay();
  });

  const selectObserver = new MutationObserver(() => {
    syncDisplay();
    if (!menu.hidden) renderMenu(searching ? input.value : '');
  });
  selectObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['label'] });

  const reposition = () => positionMenu();
  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, true);

  const lifecycleObserver = new MutationObserver(() => {
    if (select.isConnected && field.isConnected) return;
    selectObserver.disconnect();
    lifecycleObserver.disconnect();
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
    menu.remove();
  });
  lifecycleObserver.observe(document.documentElement, { childList: true, subtree: true });

  syncDisplay();
}

function enhanceAllStatSelects(root: ParentNode = document) {
  root.querySelectorAll<HTMLSelectElement>('label.field-label.compact > select').forEach(enhanceStatSelect);
}

const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('label.field-label.compact > select') && node instanceof HTMLSelectElement) enhanceStatSelect(node);
      enhanceAllStatSelects(node);
    });
  });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => enhanceAllStatSelects(), { once: true });
} else {
  enhanceAllStatSelects();
}
observer.observe(document.documentElement, { childList: true, subtree: true });
