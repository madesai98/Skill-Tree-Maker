import { ChangeEvent } from 'react';

export type IconAsset = {
  id: string;
  name: string;
  svg: string;
};

const MAX_SVG_BYTES = 256 * 1024;
const BLOCKED_ELEMENTS = 'script,foreignObject,iframe,object,embed,audio,video';

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
