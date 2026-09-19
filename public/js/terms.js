(() => {
  const dialog = document.getElementById('termsDialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;
  // Native modal blocks background; open HTML remains the no-JS fallback.
  dialog.removeAttribute('open');
  dialog.showModal();
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = dialog.querySelectorAll('a[href], button, input:not([type="hidden"])');
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    window.location.assign(document.getElementById('termsDecline').href);
  });
})();
