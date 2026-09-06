import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const DEFAULT_EXTENSION_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'dist');
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
  const prefix = '--' + name + '=';
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('DevTools endpoint returned HTTP ' + response.status);
  }
  return response.json();
}

async function waitForVersion(port, child, timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Chrome exited before DevTools became ready (code ' + child.exitCode + ').');
    }
    try {
      return await fetchJson('http://127.0.0.1:' + port + '/json/version');
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(
    'Timed out waiting for Chrome DevTools on port ' + port + ': ' + (lastError?.message ?? 'unknown error'),
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
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(String(message.error.code) + ': ' + message.error.message));
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
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message));
    });
  };

  return { command, events, socket };
}

async function evaluate(connection, sessionId, expression) {
  const result = await connection.command(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Page evaluation failed.');
  }
  return result?.result?.value;
}

async function waitForCondition(connection, sessionId, expression, timeoutMilliseconds = 20000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(connection, sessionId, expression);
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Timed out waiting for condition: ' + expression);
}

async function findExtensionId(connection, sessionId) {
  const expression = [
    '(() => {',
    '  function collect(root, output = []) {',
    '    if (!root?.querySelectorAll) return output;',
    '    for (const node of root.querySelectorAll("*")) {',
    '      if (node.localName === "extensions-item") {',
    '        output.push({',
    '          id: node.getAttribute("id") || node.id || "",',
    '          text: node.shadowRoot?.innerText || node.innerText || "",',
    '        });',
    '      }',
    '      if (node.shadowRoot) collect(node.shadowRoot, output);',
    '    }',
    '    return output;',
    '  }',
    '  return collect(document);',
    '})()',
  ].join('\n');

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const items = await evaluate(connection, sessionId, expression) || [];
    const candidate = items.find((item) => /typewriter/i.test(item.text)) || items[0];
    if (/^[a-p]{32}$/.test(candidate?.id)) return candidate.id;
    await sleep(100);
  }
  throw new Error('Could not determine the unpacked Typewriter extension ID.');
}

async function createExtensionSession(connection, extensionId, page) {
  const target = await connection.command('Target.createTarget', {
    url: 'chrome-extension://' + extensionId + '/' + page,
  });
  const attached = await connection.command('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;
  await connection.command('Runtime.enable', {}, sessionId);
  await connection.command('Page.enable', {}, sessionId);
  await connection.command('Network.enable', {}, sessionId);
  await waitForCondition(
    connection,
    sessionId,
    'document.readyState === "complete" && Boolean(document.querySelector("[data-product-surface]"))',
  );
  return { sessionId, targetId: target.targetId };
}

async function closeChrome(child) {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), sleep(2000)]);
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function runCftProduct({
  chromePath = DEFAULT_CHROME_CANDIDATES[0],
  extensionDirectory = DEFAULT_EXTENSION_DIRECTORY,
  port = 9230,
  profileDirectory = undefined,
} = {}) {
  if (!chromePath) {
    throw new Error(
      'Chrome for Testing path is required. Pass --chrome=/path/to/Google Chrome for Testing.',
    );
  }

  const ownedProfile = !profileDirectory;
  const resolvedProfileDirectory = profileDirectory || await mkdtemp(
    path.join(os.tmpdir(), 'typewriter-product-cft-'),
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
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + resolvedProfileDirectory,
    'about:blank',
  ];
  const child = spawn(chromePath, chromeArguments, {
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  let connection;
  let managerTargetId;
  const extensionTargets = [];
  try {
    const version = await waitForVersion(port, child);
    connection = connect(version.webSocketDebuggerUrl);

    const manager = await connection.command('Target.createTarget', {
      url: 'chrome://extensions/',
    });
    managerTargetId = manager.targetId;
    const managerSession = await connection.command('Target.attachToTarget', {
      targetId: managerTargetId,
      flatten: true,
    });
    await connection.command('Runtime.enable', {}, managerSession.sessionId);
    const extensionId = await findExtensionId(connection, managerSession.sessionId);

    const popup = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popup);
    await waitForCondition(
      connection,
      popup.sessionId,
      'Boolean(document.querySelector("[aria-label=\\"검색어\\"]"))',
    );
    await evaluate(connection, popup.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.focus();',
      '  input.value = "담담하다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})()',
    ].join('\n'));
    await waitForCondition(
      connection,
      popup.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w026\\"]"))',
    );
    const popupReady = await evaluate(connection, popup.sessionId, [
      '(() => ({',
      '  recordId: document.querySelector("[data-dictionary-record]")?.dataset.recordId || "",',
      '  hasDirectTarget: Boolean(document.querySelector("[data-target-record-id=\\"r008\\"]")),',
      '  inputFocused: document.activeElement?.matches("[aria-label=\\"검색어\\"]") || false,',
      '  inputOutlineStyle: getComputedStyle(document.querySelector("[aria-label=\\"검색어\\"]")).outlineStyle,',
      '  scrollMaxHeight: getComputedStyle(document.querySelector(".dictionary-scroll-region")).maxHeight,',
      '  scrollOverflowY: getComputedStyle(document.querySelector(".dictionary-scroll-region")).overflowY,',
      '  panelWidth: Math.round(document.querySelector("[data-dictionary-panel]").getBoundingClientRect().width),',
      '  panelHeight: Math.round(document.querySelector("[data-dictionary-panel]").getBoundingClientRect().height),',
      '}))()',
    ].join('\n'));
    await evaluate(connection, popup.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.focus();',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Tab", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})()',
    ].join('\n'));
    const focusResult = await evaluate(
      connection,
      popup.sessionId,
      'document.activeElement?.className || ""',
    );
    await evaluate(
      connection,
      popup.sessionId,
      'document.querySelector("[data-target-record-id=\\"r008\\"]")?.click()',
    );
    await waitForCondition(
      connection,
      popup.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"r008\\"]"))',
    );
    await evaluate(connection, popup.sessionId, 'document.querySelector(".back-button")?.click()');
    await waitForCondition(
      connection,
      popup.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w026\\"]")) && !document.querySelector("[data-record-id=\\"r008\\"]")',
    );

    const popupEmpty = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupEmpty);
    await evaluate(connection, popupEmpty.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "test";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupEmpty.sessionId,
      'Boolean(document.querySelector("[data-search-state=\\"empty\\"]"))',
    );
    const popupEmptyState = await evaluate(connection, popupEmpty.sessionId, [
      '(() => {',
      '  const panel = document.querySelector("[data-dictionary-panel]");',
      '  return {',
      '    panelHeight: Math.round(panel.getBoundingClientRect().height),',
      '    bodyHeight: document.body.scrollHeight,',
      '    appHeight: Math.round(document.querySelector("#app").getBoundingClientRect().height),',
      '    hasFooter: Boolean(document.querySelector(".product-footer")),',
      '  };',
      '})() ',
    ].join('\n'));

    const popupLong = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupLong);
    await evaluate(connection, popupLong.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "쓰다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupLong.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w237\\"]"))',
    );
    const popupLongOverflow = await evaluate(connection, popupLong.sessionId, [
      '(() => {',
      '  const panel = document.querySelector("[data-dictionary-panel]");',
      '  const region = document.querySelector(".dictionary-scroll-region");',
      '  return {',
      '    panelHeight: Math.round(panel.getBoundingClientRect().height),',
      '    regionClientHeight: Math.round(region.clientHeight),',
      '    regionScrollHeight: Math.round(region.scrollHeight),',
      '    overflowY: getComputedStyle(region).overflowY,',
      '    hasSearch: Boolean(document.querySelector("[aria-label=\\"검색어\\"]")),',
      '    hasFooter: Boolean(document.querySelector(".product-footer")),',
      '  };',
      '})() ',
    ].join('\n'));
    const popupLongScroll = await evaluate(connection, popupLong.sessionId, [
      '(() => {',
      '  const region = document.querySelector(".dictionary-scroll-region");',
      '  const before = region.scrollTop;',
      '  region.scrollTop = region.scrollHeight;',
      '  return { before, after: region.scrollTop, max: region.scrollHeight - region.clientHeight };',
      '})() ',
    ].join('\n'));

    const options = await createExtensionSession(connection, extensionId, 'options.html');
    extensionTargets.push(options);
    await waitForCondition(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]").length === 5',
    );
    const optionsDefault = await evaluate(connection, options.sessionId, [
      '(() => ({',
      '  switches: [...document.querySelectorAll("[role=\\"switch\\"]")].map((node) => node.getAttribute("aria-checked")),',
      '  previewRecord: document.querySelector("[data-record-id=\\"preview-w006\\"]")?.dataset.recordId || "",',
      '  hasAntonymByDefault: Boolean(document.querySelector(".preview-panel [data-group-id=\\"antonyms\\"]")),',
      '}))()',
    ].join('\n'));
    await evaluate(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]")[2]?.click()',
    );
    await waitForCondition(
      connection,
      options.sessionId,
      'document.querySelector(".preview-panel [data-group-id=\\"antonyms\\"]") !== null',
    );
    const optionsDirty = await evaluate(connection, options.sessionId, [
      '(() => ({',
      '  status: document.querySelector(".save-status")?.textContent.trim() || "",',
      '  saveDisabled: document.querySelector(".save-button")?.disabled ?? true,',
      '}))() ',
    ].join('\n'));
    await evaluate(connection, options.sessionId, 'document.querySelector(".save-button")?.click()');
    await waitForCondition(
      connection,
      options.sessionId,
      'document.querySelector(".save-status")?.textContent.includes("저장됨") && document.querySelector(".save-button")?.disabled === true',
    );
    await connection.command('Page.reload', {}, options.sessionId);
    await waitForCondition(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]")[2]?.getAttribute("aria-checked") === "true"',
    );
    const optionsReloaded = await evaluate(connection, options.sessionId, [
      '(() => ({',
      '  antonymEnabled: document.querySelectorAll("[role=\\"switch\\"]")[2]?.getAttribute("aria-checked") === "true",',
      '  hasAntonymAfterReload: Boolean(document.querySelector(".preview-panel [data-group-id=\\"antonyms\\"]")),',
      '}))()',
    ].join('\n'));

    const prefix = 'chrome-extension://' + extensionId + '/';
    const nonExtensionRequests = connection.events
      .filter((message) => message.method === 'Network.requestWillBeSent')
      .map((message) => message.params.request.url)
      .filter((url) => !url.startsWith(prefix));

    if (
      popupReady.recordId !== 'w026'
      || !popupReady.hasDirectTarget
      || !popupReady.inputFocused
      || popupReady.inputOutlineStyle !== 'none'
      || popupReady.scrollMaxHeight !== '487px'
      || popupReady.scrollOverflowY !== 'auto'
      || popupReady.panelWidth !== 480
      || popupReady.panelHeight < 376
      || focusResult !== 'search-button'
    ) {
      throw new Error('Popup CFT assertions failed: ' + JSON.stringify({ popupReady, focusResult }));
    }
    if (
      popupEmptyState.panelHeight >= 240
      || popupEmptyState.bodyHeight !== popupEmptyState.panelHeight
      || popupEmptyState.appHeight !== popupEmptyState.panelHeight
      || !popupEmptyState.hasFooter
    ) {
      throw new Error('Empty popup sizing CFT assertions failed: ' + JSON.stringify(popupEmptyState));
    }
    if (
      popupLongOverflow.regionScrollHeight <= popupLongOverflow.regionClientHeight
      || popupLongOverflow.overflowY !== 'auto'
      || popupLongOverflow.panelHeight >= 600
      || !popupLongOverflow.hasSearch
      || !popupLongOverflow.hasFooter
      || popupLongScroll.after <= popupLongScroll.before
      || popupLongScroll.after !== popupLongScroll.max
    ) {
      throw new Error('Long-result overflow CFT assertions failed: ' + JSON.stringify({ popupLongOverflow, popupLongScroll }));
    }
    if (
      JSON.stringify(optionsDefault.switches) !== JSON.stringify(['true', 'true', 'false', 'true', 'false'])
      || optionsDefault.previewRecord !== 'preview-w006'
      || optionsDefault.hasAntonymByDefault
    ) {
      throw new Error('Default Settings CFT assertions failed: ' + JSON.stringify(optionsDefault));
    }
    if (!optionsReloaded.antonymEnabled || !optionsReloaded.hasAntonymAfterReload) {
      throw new Error('Persisted Settings CFT assertions failed: ' + JSON.stringify(optionsReloaded));
    }
    if (optionsDirty.status !== '저장되지 않음' || optionsDirty.saveDisabled) {
      throw new Error('Dirty Settings CFT assertions failed: ' + JSON.stringify(optionsDirty));
    }
    if (nonExtensionRequests.length > 0) {
      throw new Error('Product UI made non-extension requests: ' + JSON.stringify(nonExtensionRequests));
    }

    return {
      extensionId,
      popupReady,
      popupEmptyState,
      popupLongOverflow,
      popupLongScroll,
      focusResult,
      optionsDefault,
      optionsDirty,
      optionsReloaded,
      nonExtensionRequests,
    };
  } finally {
    if (connection) {
      for (const target of extensionTargets) {
        await connection.command('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      }
      if (managerTargetId) {
        await connection.command('Target.closeTarget', { targetId: managerTargetId }).catch(() => {});
      }
      connection.socket.close();
    }
    await closeChrome(child);
    if (ownedProfile) {
      await rm(resolvedProfileDirectory, { recursive: true, force: true });
    }
  }
}

export async function main() {
  const summary = await runCftProduct({
    chromePath: option('chrome'),
    extensionDirectory: option('extension', DEFAULT_EXTENSION_DIRECTORY),
    port: Number(option('port', '9230')),
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
