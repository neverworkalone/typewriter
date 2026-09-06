import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { assertProofPayload } from '../../extension/mv3-proof/proof-contract.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_EXTENSION_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'dist/mv3-proof',
);
const DEFAULT_CHROME_CANDIDATES = [
  process.env.TYPEWRITER_CFT,
  path.resolve(
    REPOSITORY_DIRECTORY,
    '../codex/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
].filter(Boolean);

const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function option(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForVersion(port, child, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited before DevTools became ready (code ${child.exitCode}).${child.stderrText ? ` ${child.stderrText}` : ''}`,
      );
    }
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(
    `Timed out waiting for Chrome DevTools on port ${port}: ${lastError?.message ?? 'unknown error'}`,
  );
}

function connect(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];

  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(`${message.error.code}: ${message.error.message}`),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }
    events.push(message);
  });

  const command = async (method, params = {}, sessionId = undefined) => {
    await open;
    const id = ++nextId;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message));
    });
  };

  return { command, events, open, socket };
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.command(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  return result?.result?.value;
}

async function findExtensionId(connection, sessionId) {
  const findWithDevToolsDom = async () => {
    await connection.command('DOM.enable', {}, sessionId);
    const {root} = await connection.command(
      'DOM.getDocument',
      {depth: -1, pierce: true},
      sessionId
    );
    const candidates = [];
    const visit = node => {
      if (node.nodeName?.toLowerCase() === 'extensions-item') {
        const attributes = Object.fromEntries(
          (node.attributes || []).reduce((pairs, value, index, values) => {
            if (index % 2 === 0) pairs.push([value, values[index + 1]]);
            return pairs;
          }, [])
        );
        candidates.push({id: attributes.id || '', attributes});
      }
      for (const child of node.children || []) visit(child);
      for (const shadowRoot of node.shadowRoots || []) visit(shadowRoot);
      if (node.contentDocument) visit(node.contentDocument);
    };
    visit(root);
    const candidate = candidates.find(item => /^[a-p]{32}$/.test(item.id));
    return candidate?.id || null;
  };

  try {
    const extensionId = await findWithDevToolsDom();
    if (extensionId) {
      return {id: extensionId, items: []};
    }
  } catch {
    // Fall back to the page-side traversal used by older Chrome WebUI versions.
  }

  const expression = `(() => {
    function collect(root, output = []) {
      if (!root?.querySelectorAll) return output;
      for (const node of root.querySelectorAll('*')) {
        if (node.localName === 'extensions-item') {
          output.push({
            id: node.getAttribute('id') || node.id || '',
            text: node.shadowRoot?.innerText || node.innerText || '',
            html: node.outerHTML.slice(0, 1200),
          });
        }
        if (node.shadowRoot) collect(node.shadowRoot, output);
      }
      return output;
    }
    return collect(document);
  })()`;

  const deadline = Date.now() + 5000;
  let items = [];
  while (Date.now() < deadline) {
    items = await evaluate(connection, sessionId, expression) || [];
    const matchingItem = items.find((item) => /typewriter/i.test(item.text));
    const candidate = matchingItem || items[0];
    const id = candidate?.id;
    if (/^[a-p]{32}$/.test(id)) {
      return { id, items };
    }
    await sleep(100);
  }

  const bodyText = await evaluate(
    connection,
    sessionId,
    'document.body?.innerText || document.documentElement?.innerHTML || ""',
  );
  let devToolsDomError = '';
  try {
    const extensionId = await findWithDevToolsDom();
    if (extensionId) {
      return {id: extensionId, items};
    }
  } catch (error) {
    devToolsDomError = error.message;
  }
  throw new Error(
    `Could not determine the unpacked extension ID. Items: ${JSON.stringify(items)} Body: ${String(bodyText).slice(0, 2000)}${devToolsDomError ? ` DevTools DOM: ${devToolsDomError}` : ''}`,
  );
}

async function readProofPage(connection, sessionId) {
  return evaluate(
    connection,
    sessionId,
    `(() => ({
      status: document.querySelector('#status')?.textContent || '',
      result: document.querySelector('#result')?.textContent || '',
    }))()`,
  );
}

async function waitForProof(connection, sessionId, timeoutMilliseconds = 20000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let page = await readProofPage(connection, sessionId);
  while (Date.now() < deadline) {
    if (page?.status === 'Proof passed' || page?.status === 'Proof failed') {
      return page;
    }
    await sleep(100);
    page = await readProofPage(connection, sessionId);
  }
  throw new Error(`Timed out waiting for MV3 proof page: ${JSON.stringify(page)}`);
}

function extensionRequests(connection, sessionId, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  return connection.events
    .filter((message) => message.sessionId === sessionId)
    .filter((message) => message.method === 'Network.requestWillBeSent')
    .map((message) => message.params.request.url)
    .filter((url) => !url.startsWith(prefix));
}

async function closeChrome(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit'),
      sleep(2000),
    ]);
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function removeTemporaryDirectory(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

export async function runCftProof({
  chromePath = DEFAULT_CHROME_CANDIDATES[0],
  extensionDirectory = DEFAULT_EXTENSION_DIRECTORY,
  port = 9229,
  profileDirectory = undefined,
} = {}) {
  if (!chromePath) {
    throw new Error(
      'Chrome for Testing path is required. Pass --chrome=/path/to/Google Chrome for Testing or set TYPEWRITER_CFT.',
    );
  }

  const ownedProfile = !profileDirectory;
  const resolvedProfileDirectory = profileDirectory || await mkdtemp(
    path.join(os.tmpdir(), 'typewriter-mv3-cft-'),
  );
  const chromeArguments = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--use-mock-keychain',
    '--disable-extensions-except=' + path.resolve(extensionDirectory),
    '--load-extension=' + path.resolve(extensionDirectory),
    '--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost',
    '--no-proxy-server',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolvedProfileDirectory}`,
    'about:blank',
  ];

  const child = spawn(chromePath, chromeArguments, {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrText = '';
  child.stderr?.on('data', (chunk) => {
    stderrText = `${stderrText}${chunk}`.slice(-4000);
  });
  child.stderrText = stderrText;
  child.stderr?.on('data', () => {
    child.stderrText = stderrText;
  });

  let connection;
  let proofTargetId;
  let extensionManagerTargetId;
  try {
    const version = await waitForVersion(port, child);
    connection = connect(version.webSocketDebuggerUrl);

    const extensionManager = await connection.command('Target.createTarget', {
      url: 'chrome://extensions/',
    });
    extensionManagerTargetId = extensionManager.targetId;
    const extensionManagerSession = await connection.command(
      'Target.attachToTarget',
      { targetId: extensionManagerTargetId, flatten: true },
    );
    const extensionManagerSessionId = extensionManagerSession.sessionId;
    await connection.command('Runtime.enable', {}, extensionManagerSessionId);
    const { id: extensionId } = await findExtensionId(
      connection,
      extensionManagerSessionId,
    );

    const proofTarget = await connection.command('Target.createTarget', {
      url: 'about:blank',
    });
    proofTargetId = proofTarget.targetId;
    const proofSession = await connection.command(
      'Target.attachToTarget',
      { targetId: proofTargetId, flatten: true },
    );
    const proofSessionId = proofSession.sessionId;
    await connection.command('Runtime.enable', {}, proofSessionId);
    await connection.command('Page.enable', {}, proofSessionId);
    await connection.command('Network.enable', {}, proofSessionId);
    await connection.command(
      'Page.navigate',
      { url: `chrome-extension://${extensionId}/proof.html` },
      proofSessionId,
    );

    const page = await waitForProof(connection, proofSessionId);
    if (page?.status !== 'Proof passed') {
      throw new Error(`MV3 proof failed: ${page?.result || page?.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(page.result);
    } catch (error) {
      throw new Error(`MV3 proof returned invalid JSON: ${error.message}`);
    }
    const nonExtensionRequests = extensionRequests(
      connection,
      proofSessionId,
      extensionId,
    );
    if (nonExtensionRequests.length > 0) {
      throw new Error(
        `MV3 proof made non-extension requests: ${JSON.stringify(nonExtensionRequests)}`,
      );
    }
    assertProofPayload(payload);

    return {
      extensionId,
      nonExtensionRequests,
      payload,
    };
  } finally {
    if (connection) {
      if (proofTargetId) {
        await connection.command('Target.closeTarget', { targetId: proofTargetId }).catch(() => {});
      }
      if (extensionManagerTargetId) {
        await connection.command('Target.closeTarget', { targetId: extensionManagerTargetId }).catch(() => {});
      }
      connection.socket.close();
    }
    await closeChrome(child);
    if (ownedProfile) {
      await removeTemporaryDirectory(resolvedProfileDirectory);
    }
  }
}

export async function main() {
  const summary = await runCftProof({
    chromePath: option('chrome'),
    extensionDirectory: option('extension', DEFAULT_EXTENSION_DIRECTORY),
    port: Number(option('port', '9229')),
    profileDirectory: option('profile'),
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
