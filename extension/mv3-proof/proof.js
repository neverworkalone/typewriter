const statusElement = document.querySelector('#status');
const resultElement = document.querySelector('#result');

function showResult(status, payload) {
  statusElement.dataset.status = status;
  statusElement.textContent = status === 'success' ? 'Proof passed' : 'Proof failed';
  resultElement.textContent = JSON.stringify(payload, null, 2);
}

const worker = new Worker(
  chrome.runtime.getURL('sqlite-worker.mjs'),
  { type: 'module' },
);

worker.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'proof-result') {
    showResult(message.ok ? 'success' : 'error', message);
    worker.terminate();
  }
});

worker.addEventListener('error', (event) => {
  showResult('error', {
    ok: false,
    error: event.message || 'SQLite worker failed to initialize',
  });
});

worker.postMessage({ type: 'run-proof' });
