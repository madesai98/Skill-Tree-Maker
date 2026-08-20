import { parseFirebaseConfigInput } from './firebaseConfig';

const CONFIG_SECTION_SELECTOR = '.project-manager-config';
const CONFIG_TEXTAREA_SELECTOR = `${CONFIG_SECTION_SELECTOR} textarea`;
const CONNECT_ACTION_SELECTOR = '[data-project-action="connect"]';

function prepareConfigInput() {
  document.querySelectorAll<HTMLElement>(CONFIG_SECTION_SELECTOR).forEach((section) => {
    const hint = section.querySelector<HTMLElement>('small');
    if (hint) {
      hint.textContent = 'Paste the Firebase web config exactly as Firebase gives it to you — the full const firebaseConfig snippet, object literal, or JSON all work.';
    }

    const textarea = section.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) return;
    textarea.placeholder = `const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};`;
    textarea.autocomplete = 'off';
    textarea.autocapitalize = 'off';
    textarea.spellcheck = false;
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('aria-label', 'Firebase web configuration');
  });
}

/**
 * projectRuntime owns the connection flow and intentionally expects normalized JSON.
 * This small input adapter runs first, accepts the formats Firebase actually shows in
 * its setup UI, and replaces the textarea contents with safe strict JSON before that
 * existing connection handler receives the click.
 */
function normalizeBeforeConnect(event: Event) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(CONNECT_ACTION_SELECTOR)) return;

  const textarea = document.querySelector<HTMLTextAreaElement>(CONFIG_TEXTAREA_SELECTOR);
  if (!textarea) return;

  try {
    const config = parseFirebaseConfigInput(textarea.value);
    textarea.value = JSON.stringify(config, null, 2);
  } catch (error) {
    // Prevent projectRuntime's strict JSON parser from replacing the useful parser
    // error with a generic JSON.parse syntax message.
    event.preventDefault();
    event.stopPropagation();
    window.alert(error instanceof Error ? error.message : 'The Firebase configuration could not be read.');
  }
}

document.addEventListener('click', normalizeBeforeConnect, true);

const observer = new MutationObserver(prepareConfigInput);
observer.observe(document.documentElement, { childList: true, subtree: true });
prepareConfigInput();
