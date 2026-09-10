const LOW_DETAIL_ZOOM = 0.2;
const MINIMAL_DETAIL_ZOOM = 0.1;

let observedViewport: HTMLElement | null = null;
let viewportObserver: MutationObserver | null = null;

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

function attachCurrentViewport() {
  if (observedViewport?.isConnected) return;

  viewportObserver?.disconnect();
  viewportObserver = null;
  observedViewport = document.querySelector<HTMLElement>('.flow-panel .react-flow__viewport');
  if (!observedViewport) return;

  syncViewportDetail(observedViewport);
  viewportObserver = new MutationObserver(() => {
    if (observedViewport) syncViewportDetail(observedViewport);
  });
  viewportObserver.observe(observedViewport, {
    attributes: true,
    attributeFilter: ['style'],
  });
}

attachCurrentViewport();
new MutationObserver(() => {
  if (!observedViewport?.isConnected) attachCurrentViewport();
}).observe(document.documentElement, { childList: true, subtree: true });
