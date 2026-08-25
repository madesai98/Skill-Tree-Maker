import './statSearchSelect.css';
import {
  recommendUpgradeStat,
  type UpgradeRecommendationEdge,
  type UpgradeRecommendationNode,
  type UpgradeRecommendationStat,
  type UpgradeStatRecommendation,
} from './statUpgradeRecommendation';

const STORAGE_KEY = 'incremental-td-skill-tree:v2';
const ENHANCED_ATTR = 'data-fuzzy-stat-select';
const CONTEXT_SORT_THRESHOLD = 42;

type StoredStat = {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  type?: unknown;
  groupId?: unknown;
  groupName?: unknown;
  groupKey?: unknown;
};

type StoredUpgrade = {
  statId?: unknown;
};

type StoredNode = {
  id?: unknown;
  data?: unknown;
};

type StoredEdge = {
  source?: unknown;
  target?: unknown;
};

type ProjectMetadata = {
  stats: Map<string, UpgradeRecommendationStat>;
  nodes: UpgradeRecommendationNode[];
  edges: UpgradeRecommendationEdge[];
};

type SearchOption = UpgradeRecommendationStat & {
  option: HTMLOptionElement;
};

type SearchGroup = {
  id: string;
  name: string;
  options: SearchOption[];
  originalIndex: number;
};

function readProjectMetadata(): ProjectMetadata {
  const stats = new Map<string, UpgradeRecommendationStat>();
  const nodes: UpgradeRecommendationNode[] = [];
  const edges: UpgradeRecommendationEdge[] = [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { stats, nodes, edges };
    const project = JSON.parse(raw) as { stats?: unknown; nodes?: unknown; edges?: unknown };

    if (Array.isArray(project.stats)) {
      project.stats.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const stat = item as StoredStat;
        if (typeof stat.id !== 'string') return;
        stats.set(stat.id, {
          id: stat.id,
          key: typeof stat.key === 'string' ? stat.key : '',
          name: typeof stat.name === 'string' ? stat.name : '',
          type: stat.type === 'boolean' ? 'boolean' : 'number',
          groupId: typeof stat.groupId === 'string' ? stat.groupId : '',
          groupName: typeof stat.groupName === 'string' ? stat.groupName : '',
          groupKey: typeof stat.groupKey === 'string' ? stat.groupKey : '',
        });
      });
    }

    if (Array.isArray(project.nodes)) {
      project.nodes.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const node = item as StoredNode;
        if (typeof node.id !== 'string' || !node.data || typeof node.data !== 'object') return;
        const data = node.data as { name?: unknown; upgrades?: unknown };
        const upgrades = Array.isArray(data.upgrades)
          ? data.upgrades.flatMap((upgradeItem) => {
              if (!upgradeItem || typeof upgradeItem !== 'object') return [];
              const upgrade = upgradeItem as StoredUpgrade;
              return typeof upgrade.statId === 'string' ? [{ statId: upgrade.statId }] : [];
            })
          : [];
        nodes.push({
          id: node.id,
          data: {
            name: typeof data.name === 'string' ? data.name : '',
            upgrades,
          },
        });
      });
    }

    if (Array.isArray(project.edges)) {
      project.edges.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const edge = item as StoredEdge;
        if (typeof edge.source !== 'string' || typeof edge.target !== 'string') return;
        edges.push({ source: edge.source, target: edge.target });
      });
    }
  } catch {
    // Search can still use the option and optgroup labels if storage is unavailable.
  }

  return { stats, nodes, edges };
}

function optionName(option: HTMLOptionElement) {
  return (option.textContent?.trim() ?? '').replace(/\s+—\s+already used$/i, '');
}

function selectedDisplay(select: HTMLSelectElement) {
  const option = select.selectedOptions[0];
  if (!option) return '';
  const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label.trim() : '';
  return group ? `${group} ${optionName(option)}`.trim() : optionName(option);
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
  const fields = [option.name, option.groupName, option.key].map(normalized);
  const combined = normalized(`${option.groupName} ${option.name} ${option.key}`);
  return tokens.every((token) => fields.some((field) => fuzzyTokenMatches(token, field)) || fuzzyTokenMatches(token, combined));
}

function nativeSetSelectValue(select: HTMLSelectElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (valueSetter) valueSetter.call(select, value);
  else select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
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

function treeInspectorFor(element: Element) {
  const inspector = element.closest('aside.inspector');
  return inspector && inspector.closest('.tree-layout') ? inspector : null;
}

function selectedTreeNodeId(inspector: Element) {
  return inspector
    .querySelector('.inspector-scroll > .inspector-section .section-title-row .id-chip')
    ?.textContent
    ?.trim() ?? '';
}

function selectedTreeNodeName(inspector: Element) {
  const firstSection = inspector.querySelector('.inspector-scroll > .inspector-section');
  const nameInput = firstSection?.querySelector<HTMLInputElement>('label.field-label > input');
  return nameInput?.value ?? inspector.querySelector('.inspector-heading h2')?.textContent?.trim() ?? '';
}

function statSelectsInInspector(inspector: Element) {
  return Array.from(inspector.querySelectorAll<HTMLSelectElement>('label.field-label.compact > select')).filter(isStatSelect);
}

function buildSearchGroups(select: HTMLSelectElement, metadata: ProjectMetadata) {
  const groups: SearchGroup[] = [];
  let groupIndex = 0;

  Array.from(select.children).forEach((child) => {
    if (child instanceof HTMLOptGroupElement) {
      const groupName = child.label.trim();
      const options = Array.from(child.querySelectorAll('option')).map<SearchOption>((option) => {
        const meta = metadata.stats.get(option.value);
        return {
          id: option.value,
          key: meta?.key ?? '',
          name: optionName(option),
          type: meta?.type ?? 'number',
          groupId: meta?.groupId || `label:${groupName}`,
          groupName: groupName || meta?.groupName || '',
          groupKey: meta?.groupKey ?? '',
          option,
        };
      });
      const groupId = options[0]?.groupId ?? `label:${groupName}`;
      groups.push({ id: groupId, name: groupName, options, originalIndex: groupIndex });
      groupIndex += 1;
      return;
    }

    if (child instanceof HTMLOptionElement) {
      const meta = metadata.stats.get(child.value);
      const item: SearchOption = {
        id: child.value,
        key: meta?.key ?? '',
        name: optionName(child),
        type: meta?.type ?? 'number',
        groupId: meta?.groupId || `ungrouped:${child.value}`,
        groupName: meta?.groupName ?? '',
        groupKey: meta?.groupKey ?? '',
        option: child,
      };
      groups.push({ id: item.groupId, name: item.groupName, options: [item], originalIndex: groupIndex });
      groupIndex += 1;
    }
  });

  return groups;
}

function recommendationForSelect(
  select: HTMLSelectElement,
  metadata: ProjectMetadata,
  groups: SearchGroup[],
  excludeCurrent: boolean,
): UpgradeStatRecommendation | null {
  const inspector = treeInspectorFor(select);
  if (!inspector) return null;
  const nodeId = selectedTreeNodeId(inspector);
  if (!nodeId) return null;

  const options = groups.flatMap((group) => group.options);
  const eligibleStatIds = new Set(options.filter((item) => !item.option.disabled).map((item) => item.id));
  const currentStatIds = statSelectsInInspector(inspector)
    .filter((item) => !excludeCurrent || item !== select)
    .map((item) => item.value)
    .filter(Boolean);

  return recommendUpgradeStat({
    nodeId,
    nodeName: selectedTreeNodeName(inspector),
    currentStatIds,
    stats: options.map(({ option: _option, ...stat }) => stat),
    nodes: metadata.nodes,
    edges: metadata.edges,
    eligibleStatIds,
  });
}

function collectGroups(select: HTMLSelectElement, query: string) {
  const metadata = readProjectMetadata();
  const baseGroups = buildSearchGroups(select, metadata);
  const recommendation = recommendationForSelect(select, metadata, baseGroups, false);
  const preferredOrder = new Map((recommendation?.preferredGroupIds ?? []).map((groupId, index) => [groupId, index]));
  const hasSearch = normalized(query).length > 0;

  const groups = baseGroups
    .map((group) => ({
      ...group,
      options: group.options.filter((item) => fuzzyMatches(query, item)),
    }))
    .filter((group) => group.options.length > 0)
    .sort((left, right) => {
      const leftPreferred = preferredOrder.get(left.id);
      const rightPreferred = preferredOrder.get(right.id);
      if (leftPreferred !== undefined || rightPreferred !== undefined) {
        if (leftPreferred === undefined) return 1;
        if (rightPreferred === undefined) return -1;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      }
      return left.originalIndex - right.originalIndex;
    });

  if (!hasSearch && recommendation) {
    groups.forEach((group) => {
      if (!preferredOrder.has(group.id)) return;
      const highestScore = Math.max(...group.options.map((item) => recommendation.scoreByStatId.get(item.id) ?? 0));
      if (highestScore < CONTEXT_SORT_THRESHOLD) return;
      group.options = group.options
        .map((item, index) => ({ item, index, score: recommendation.scoreByStatId.get(item.id) ?? 0 }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(({ item }) => item);
    });
  }

  return groups;
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
  let selectAllOnPointerClick = false;

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
    if (item.option.disabled) return;
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
          option.disabled = item.option.disabled;

          const name = document.createElement('span');
          name.className = 'fuzzy-stat-option-name';
          name.textContent = item.option.disabled ? `${item.name} — already used` : item.name;
          option.append(name);

          if (item.key) {
            const key = document.createElement('span');
            key.className = 'fuzzy-stat-option-key';
            key.textContent = item.key;
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

  input.addEventListener('pointerdown', () => {
    selectAllOnPointerClick = document.activeElement !== input || menu.hidden !== false;
  });

  input.addEventListener('focus', () => {
    searching = false;
    syncDisplay();
    openMenu();
    requestAnimationFrame(() => input.select());
  });

  input.addEventListener('click', () => {
    if (menu.hidden) openMenu();
    if (selectAllOnPointerClick) {
      input.select();
      selectAllOnPointerClick = false;
    }
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
  selectObserver.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['label', 'disabled'] });

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
