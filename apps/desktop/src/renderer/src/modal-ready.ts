// Packaged file URLs have an opaque origin; the opener validates the source window.
window.opener?.postMessage('xgen-modal-ready', '*');
