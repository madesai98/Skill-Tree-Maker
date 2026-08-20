export function statGameKeyFromDisplayName(name: string) {
  return name.toLowerCase().replaceAll(' ', '.');
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (valueSetter) valueSetter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

document.addEventListener('input', (event) => {
  const nameInput = event.target;
  if (!(nameInput instanceof HTMLInputElement)) return;

  const row = nameInput.closest<HTMLElement>('.stat-row');
  if (!row) return;

  const label = nameInput.closest('label');
  if (label?.querySelector<HTMLElement>('.mobile-label')?.textContent !== 'Display name') return;

  const keyInput = row.querySelector<HTMLInputElement>('input.mono-input');
  if (!keyInput || keyInput === nameInput) return;

  // Let React finish the display-name input event before updating the other
  // controlled field. Dispatching the nested input synchronously can cause
  // React to restore the display-name value and make keystrokes appear lost.
  queueMicrotask(() => {
    if (!nameInput.isConnected || !keyInput.isConnected) return;
    const nextKey = statGameKeyFromDisplayName(nameInput.value);
    if (keyInput.value === nextKey) return;
    setInputValue(keyInput, nextKey);
  });
});
