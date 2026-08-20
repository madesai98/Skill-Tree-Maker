import { ChangeEvent, useEffect, useMemo, useState } from 'react';

export type IconAsset = {
  id: string;
  name: string;
  svg: string;
};

const MAX_SVG_BYTES = 256 * 1024;
const BLOCKED_ELEMENTS = 'script,foreignObject,iframe,object,embed,audio,video';
const ICONIFY_API = 'https://api.iconify.design';
const ICONIFY_SEARCH_LIMIT = 64;

export function sanitizeSvgMarkup(input: string) {
  const trimmed = input.trim();
  if (!trimmed || new Blob([trimmed]).size > MAX_SVG_BYTES) return null;

  const documentNode = new DOMParser().parseFromString(trimmed, 'image/svg+xml');
  if (documentNode.querySelector('parsererror')) return null;
  const root = documentNode.documentElement;
  if (root.localName.toLowerCase() !== 'svg') return null;

  root.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());
  [root, ...Array.from(root.querySelectorAll('*'))].forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      if ((name === 'href' || name === 'xlink:href') && value && !value.startsWith('#') && !value.startsWith('data:image/')) {
        element.removeAttribute(attribute.name);
      }
      if (/javascript:/i.test(value)) element.removeAttribute(attribute.name);
    });
  });

  if (!root.getAttribute('viewBox')) {
    const width = Number.parseFloat(root.getAttribute('width') ?? '');
    const height = Number.parseFloat(root.getAttribute('height') ?? '');
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      root.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
  }

  return new XMLSerializer().serializeToString(root);
}

export function iconNameFromFile(file: File) {
  return file.name.replace(/\.svg$/i, '').trim() || 'Icon';
}

export function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function SvgAssetPreview({
  icon,
  className = '',
  title,
}: {
  icon: IconAsset | null | undefined;
  className?: string;
  title?: string;
}) {
  if (!icon) {
    return <span className={`svg-icon-preview is-empty ${className}`.trim()} aria-hidden="true" />;
  }

  return (
    <span className={`svg-icon-preview ${className}`.trim()} title={title ?? icon.name}>
      <img src={svgDataUrl(icon.svg)} alt="" draggable={false} />
    </span>
  );
}

type IconPickerProps = {
  icons: IconAsset[];
  value: string | null;
  onChange: (iconId: string | null) => void;
  onUpload: (file: File) => void | Promise<void>;
  compact?: boolean;
  ariaLabel?: string;
};

export function IconPicker({ icons, value, onChange, onUpload, compact = false, ariaLabel = 'Icon' }: IconPickerProps) {
  const selected = icons.find((icon) => icon.id === value) ?? null;
  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void onUpload(file);
  };

  return (
    <div className={`icon-picker${compact ? ' compact' : ''}`}>
      <SvgAssetPreview icon={selected} />
      <select aria-label={ariaLabel} value={selected?.id ?? ''} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">No icon</option>
        {icons.map((icon) => <option key={icon.id} value={icon.id}>{icon.name}</option>)}
      </select>
      <label className="icon-upload-control" title="Upload SVG">
        <span>{compact ? '+' : 'Upload SVG'}</span>
        <input type="file" accept=".svg,image/svg+xml" onChange={onFile} hidden />
      </label>
    </div>
  );
}

type IconifyLicense = {
  title?: string;
  spdx?: string;
  url?: string;
};

type IconifyCollectionInfo = {
  name?: string;
  license?: IconifyLicense;
};

type IconifySearchResponse = {
  icons?: unknown;
  collections?: unknown;
};

function parseIconifyName(value: string) {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const prefix = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!/^[a-z0-9-]+$/i.test(prefix) || !/^[a-z0-9-]+$/i.test(name)) return null;
  return { prefix, name };
}

function iconifySvgUrl(iconName: string, preview = false) {
  const parsed = parseIconifyName(iconName);
  if (!parsed) return '';
  const base = `${ICONIFY_API}/${encodeURIComponent(parsed.prefix)}/${encodeURIComponent(parsed.name)}.svg`;
  return preview ? `${base}?height=32&color=%23dfe4e9` : base;
}

function normalizeCollections(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, IconifyCollectionInfo>;
  return Object.fromEntries(Object.entries(value).flatMap(([prefix, item]) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const rawLicense = record.license;
    const license = rawLicense && typeof rawLicense === 'object' && !Array.isArray(rawLicense)
      ? rawLicense as Record<string, unknown>
      : null;
    return [[prefix, {
      name: typeof record.name === 'string' ? record.name : prefix,
      license: license ? {
        title: typeof license.title === 'string' ? license.title : undefined,
        spdx: typeof license.spdx === 'string' ? license.spdx : undefined,
        url: typeof license.url === 'string' ? license.url : undefined,
      } : undefined,
    }]];
  }));
}

export async function fetchIconifySvg(iconName: string, signal?: AbortSignal) {
  const url = iconifySvgUrl(iconName);
  if (!url) throw new Error('Iconify returned an invalid icon name.');
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Iconify SVG request failed (${response.status}).`);
  const svg = sanitizeSvgMarkup(await response.text());
  if (!svg) throw new Error('Iconify returned an SVG that could not be imported.');
  return svg;
}

type IconifySearchProps = {
  icons: IconAsset[];
  onImport: (iconName: string, svg: string) => void | Promise<void>;
};

export function IconifySearch({ icons, onImport }: IconifySearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [collections, setCollections] = useState<Record<string, IconifyCollectionInfo>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const existingNames = useMemo(() => new Set(icons.map((icon) => icon.name)), [icons]);

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      setResults([]);
      setCollections({});
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const url = `${ICONIFY_API}/search?query=${encodeURIComponent(search)}&limit=${ICONIFY_SEARCH_LIMIT}`;
      fetch(url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`Iconify search failed (${response.status}).`);
          return response.json() as Promise<IconifySearchResponse>;
        })
        .then((data) => {
          const names = Array.isArray(data.icons)
            ? data.icons.filter((item): item is string => typeof item === 'string' && Boolean(parseIconifyName(item)))
            : [];
          setResults(names);
          setCollections(normalizeCollections(data.collections));
        })
        .catch((reason: unknown) => {
          if (controller.signal.aborted) return;
          setResults([]);
          setCollections({});
          setError(reason instanceof Error ? reason.message : 'Iconify search failed.');
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const importResult = async (iconName: string) => {
    if (existingNames.has(iconName) || importing) return;
    setImporting(iconName);
    setError(null);
    try {
      const svg = await fetchIconifySvg(iconName);
      await onImport(iconName, svg);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import that Iconify icon.');
    } finally {
      setImporting(null);
    }
  };

  return (
    <section className="iconify-search-card" aria-labelledby="iconify-search-title">
      <div className="iconify-search-head">
        <div>
          <span className="section-kicker">ICONIFY</span>
          <h3 id="iconify-search-title">Search open-source icons</h3>
          <p>Search Iconify, then copy the selected SVG into this project’s persistent icon pool.</p>
        </div>
        <div className="iconify-search-input-wrap">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
          <input
            type="search"
            value={query}
            placeholder="Search icons, e.g. tower, damage, coin…"
            aria-label="Search Iconify icons"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="iconify-search-status" aria-live="polite">
        {loading
          ? 'Searching Iconify…'
          : error
            ? error
            : query.trim().length < 2
              ? 'Type at least 2 characters to search.'
              : results.length
                ? `${results.length} result${results.length === 1 ? '' : 's'} shown. Refine the search for more specific matches.`
                : 'No matching icons found.'}
      </div>

      {results.length > 0 && (
        <div className="iconify-result-grid">
          {results.map((iconName) => {
            const parsed = parseIconifyName(iconName)!;
            const collection = collections[parsed.prefix];
            const license = collection?.license?.spdx ?? collection?.license?.title ?? 'See icon set license';
            const alreadyAdded = existingNames.has(iconName);
            return (
              <article className="iconify-result" key={iconName}>
                <div className="iconify-result-preview"><img src={iconifySvgUrl(iconName, true)} alt="" loading="lazy" /></div>
                <div className="iconify-result-copy">
                  <strong title={iconName}>{parsed.name}</strong>
                  <span title={collection?.name ?? parsed.prefix}>{collection?.name ?? parsed.prefix}</span>
                  <small>{license}</small>
                </div>
                <button
                  type="button"
                  className="small-button"
                  disabled={alreadyAdded || importing !== null}
                  onClick={() => void importResult(iconName)}
                >
                  {alreadyAdded ? 'In pool' : importing === iconName ? 'Adding…' : 'Add'}
                </button>
              </article>
            );
          })}
        </div>
      )}

      <p className="iconify-license-note">Icon sets have different open-source licenses. The applicable license is shown with each search result.</p>
    </section>
  );
}
