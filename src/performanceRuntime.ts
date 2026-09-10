const LOW_DETAIL_ZOOM = 0.2;
const MINIMAL_DETAIL_ZOOM = 0.1;

function zoomFromTransform(transform: string) {
  const scale = transform.match(/scale\(([-+\d.eE]+)\)/)?.[1];
  if (scale) return Number(scale);
  const matrix = transform.match(/^matrix\(([^)]+)\)$/)?.[1];
  if (matrix) {
    const first = Number(matrix.split(',')[0]);
    if (Number.isFinite(first)) return Math.abs(first);
  }
  return 1;
}

function syncViewportDetail(viewport: HTMLElement) {
  const panel = viewport.closest<HTMLElement>('.flow-panel');
  if (!panel) return;
  const zoom = zoomFromTransform(viewport.style.transform);
  panel.classList.toggle('is-low-detail-zoom', zoom < LOW_DETAIL_ZOOM);
  panel.classList.toggle('is-minimal-detail-zoom', zoom < MINIMAL_DETAIL_ZOOM);
}

function observeViewport(viewport: HTMLElement) {
  if (viewport.dataset.performanceObserved === 'true') return;
  viewport.dataset.performanceObserved = 'true';
  syncViewportDetail(viewport);
  new MutationObserver(() => syncViewportDetail(viewport)).observe(viewport, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

function scan() {
  document.querySelectorAll<HTMLElement>('.flow-panel .react-flow__viewport').forEach(observeViewport);
}

scan();
new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
