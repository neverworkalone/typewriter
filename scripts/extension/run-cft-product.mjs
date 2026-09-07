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
  const findWithDevToolsDom = async () => {
    await connection.command('DOM.enable', {}, sessionId);
    const { root } = await connection.command(
      'DOM.getDocument',
      { depth: -1, pierce: true },
      sessionId,
    );
    const candidates = [];
    const visit = (node) => {
      if (node.nodeName?.toLowerCase() === 'extensions-item') {
        const attributes = Object.fromEntries(
          (node.attributes || []).reduce((pairs, value, index, values) => {
            if (index % 2 === 0) pairs.push([value, values[index + 1]]);
            return pairs;
          }, []),
        );
        candidates.push({
          id: attributes.id || '',
          attributes,
        });
      }
      for (const child of node.children || []) visit(child);
      for (const shadowRoot of node.shadowRoots || []) visit(shadowRoot);
      if (node.contentDocument) visit(node.contentDocument);
    };
    visit(root);
    const candidate = candidates.find((item) => /^[a-p]{32}$/.test(item.id));
    return candidate?.id || null;
  };

  try {
    const extensionId = await findWithDevToolsDom();
    if (extensionId) return extensionId;
  } catch {
    // Fall back to the page-side traversal used by older Chrome WebUI versions.
  }

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
  let devToolsDomError = '';
  try {
    const extensionId = await findWithDevToolsDom();
    if (extensionId) return extensionId;
  } catch (error) {
    devToolsDomError = error.message;
  }
  throw new Error(
    'Could not determine the unpacked Typewriter extension ID.'
      + (devToolsDomError ? ` ${devToolsDomError}` : ''),
  );
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
    await Promise.race([once(child, 'exit').catch(() => {}), sleep(2000)]);
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit').catch(() => {}), sleep(2000)]);
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
    '--password-store=basic',
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
      '  input.value = "담담";',
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
    await waitForCondition(
      connection,
      popup.sessionId,
      '(() => { const product = document.querySelector("[data-product-surface=\\"popup\\"]"); return product?.dataset.runtimeQueryOnly === "1" && product?.dataset.runtimeWriteBlocked === "true" && product?.dataset.runtimePersistedWriteCount === "0"; })()',
    );
    const popupReady = await evaluate(connection, popup.sessionId, [
      '(() => ({',
      '  recordId: document.querySelector("[data-dictionary-record]")?.dataset.recordId || "",',
      '  hasDirectTarget: Boolean(document.querySelector("[data-target-record-id=\\"r008\\"]")),',
      '  inputFocused: document.activeElement?.matches("[aria-label=\\"검색어\\"]") || false,',
      '  inputOutlineStyle: getComputedStyle(document.querySelector("[aria-label=\\"검색어\\"]")).outlineStyle,',
      '  hasClearButton: Boolean(document.querySelector(".search-clear-button")),',
      '  runtimeQueryOnly: Number(document.querySelector("[data-product-surface=\\"popup\\"]")?.dataset.runtimeQueryOnly || NaN),',
      '  runtimeWriteBlocked: document.querySelector("[data-product-surface=\\"popup\\"]")?.dataset.runtimeWriteBlocked === "true",',
      '  runtimePersistedWriteCount: Number(document.querySelector("[data-product-surface=\\"popup\\"]")?.dataset.runtimePersistedWriteCount || NaN),',
      '  scrollMaxHeight: getComputedStyle(document.querySelector(".dictionary-scroll-region")).maxHeight,',
      '  scrollOverflowY: getComputedStyle(document.querySelector(".dictionary-scroll-region")).overflowY,',
      '  scrollMinHeight: getComputedStyle(document.querySelector(".dictionary-scroll-region")).minHeight,',
      '  panelWidth: Math.round(document.querySelector("[data-dictionary-panel]").getBoundingClientRect().width),',
      '  panelHeight: Math.round(document.querySelector("[data-dictionary-panel]").getBoundingClientRect().height),',
      '  footerHeight: getComputedStyle(document.querySelector(".product-footer")).height,',
      '  footerAlignItems: getComputedStyle(document.querySelector(".product-footer")).alignItems,',
      '  footerPaddingRight: getComputedStyle(document.querySelector(".product-footer")).paddingRight,',
      '  definitionTopGap: (() => {',
      '    const divider = document.querySelector(".result-divider");',
      '    const section = document.querySelector("[data-group-id=\\"definition\\"]");',
      '    return divider && section ? Math.round((section.getBoundingClientRect().top - divider.getBoundingClientRect().bottom) * 100) / 100 : null;',
      '  })(),',
      '  definitionBottomGap: (() => {',
      '    const text = document.querySelector(".definition-text");',
      '    const divider = document.querySelector(".definition-divider");',
      '    return text && divider ? Math.round((divider.getBoundingClientRect().top - text.getBoundingClientRect().bottom) * 100) / 100 : null;',
      '  })(),',
      '}))()',
    ].join('\n'));

    const popupHomonym = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupHomonym);
    await evaluate(connection, popupHomonym.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "눈";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})()',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupHomonym.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w133\\"]")) && document.querySelectorAll("[role=\\"option\\"]").length === 2',
    );
    const popupHomonymFirst = await evaluate(connection, popupHomonym.sessionId, [
      '(() => {',
      '  const options = [...document.querySelectorAll("[role=\\"option\\"]")];',
      '  return {',
      '    optionLabels: options.map((node) => node.textContent.trim()),',
      '    selectedOptions: options.map((node) => node.getAttribute("aria-selected")),',
      '    resultCount: document.querySelectorAll("[data-dictionary-record]").length,',
      '    visibleSenseIds: [...document.querySelectorAll(".sense-block")].map((node) => node.dataset.senseId),',
      '    definition: document.querySelector(".definition-text")?.textContent.trim() || "",',
      '    hasBackButton: Boolean(document.querySelector(".back-button")),',
      '    hasHeaderDivider: Boolean(document.querySelector(".result-divider")),',
      '    candidateDefinitionGap: (() => {',
      '      const list = document.querySelector(".candidate-list");',
      '      const definition = document.querySelector("[data-group-id=\\"definition\\"]");',
      '      return list && definition ? Math.round((definition.getBoundingClientRect().top - list.getBoundingClientRect().bottom) * 100) / 100 : null;',
      '    })(),',
      '  };',
      '})() ',
    ].join('\n'));
    await evaluate(
      connection,
      popupHomonym.sessionId,
      'document.querySelector("[role=\\"option\\"][data-sense-id=\\"w133-s2\\"]")?.click()',
    );
    await waitForCondition(
      connection,
      popupHomonym.sessionId,
      'document.querySelector("[role=\\"option\\"][data-sense-id=\\"w133-s2\\"]")?.getAttribute("aria-selected") === "true" && document.querySelector(".definition-text")?.textContent.trim() === "하늘에서 내리는 흰 얼음 알갱이"',
    );
    const popupHomonymSecond = await evaluate(connection, popupHomonym.sessionId, [
      '(() => {',
      '  const options = [...document.querySelectorAll("[role=\\"option\\"]")];',
      '  return {',
      '    selectedOptions: options.map((node) => node.getAttribute("aria-selected")),',
      '    resultCount: document.querySelectorAll("[data-dictionary-record]").length,',
      '    visibleSenseIds: [...document.querySelectorAll(".sense-block")].map((node) => node.dataset.senseId),',
      '    definition: document.querySelector(".definition-text")?.textContent.trim() || "",',
      '    hasBackButton: Boolean(document.querySelector(".back-button")),',
      '  };',
      '})() ',
    ].join('\n'));

    const popupIme = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupIme);
    const popupImeStart = await evaluate(connection, popupIme.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.focus();',
      '  input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㄷ" }));',
      '  input.value = "ㄷ";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });',
      '  input.dispatchEvent(event);',
      '  return { defaultPrevented: event.defaultPrevented, inputValue: input.value, hasRecord: Boolean(document.querySelector("[data-dictionary-record]")) };',
      '})() ',
    ].join('\n'));
    await sleep(100);
    const popupImeEarly = await evaluate(connection, popupIme.sessionId, [
      '(() => ({',
      '  inputValue: document.querySelector("[aria-label=\\"검색어\\"]")?.value || "",',
      '  hasRecord: Boolean(document.querySelector("[data-dictionary-record]")),',
      '}))()',
    ].join('\n'));
    await evaluate(connection, popupIme.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "담담하다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "담담하다" }));',
      '  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });',
      '  input.dispatchEvent(event);',
      '  return { defaultPrevented: event.defaultPrevented };',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupIme.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w026\\"]"))',
    );
    await sleep(50);
    const popupImeKeyboard = await evaluate(connection, popupIme.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.focus();',
      '  const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });',
      '  input.dispatchEvent(event);',
      '  return { defaultPrevented: event.defaultPrevented };',
      '})() ',
    ].join('\n'));
    await sleep(50);
    const popupImeKeyboardState = await evaluate(connection, popupIme.sessionId, [
      '(() => {',
      '  const active = document.activeElement;',
      '  return {',
      '    activeIsInput: active?.matches("[aria-label=\\"검색어\\"]") || false,',
      '    activeRecordId: active?.dataset.recordId || "",',
      '    activeRole: active?.getAttribute("role") || "",',
      '    activeSelected: active?.getAttribute("aria-selected") || "",',
      '    candidateCount: document.querySelectorAll("[role=\\"option\\"]").length,',
      '    hasListbox: Boolean(document.querySelector("[role=\\"listbox\\"]")),',
      '  };',
      '})() ',
    ].join('\n'));
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await sleep(50);
    const popupImeTabToButton = await evaluate(connection, popupIme.sessionId, [
      '(() => ({',
      '  activeIsSearchButton: document.activeElement?.matches(".search-button") || false,',
      '}))()',
    ].join('\n'));
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await sleep(50);
    const popupImeTab = await evaluate(connection, popupIme.sessionId, [
      '(() => ({',
      '  activeIsRelation: document.activeElement?.matches(".relation-link") || false,',
      '  outlineStyle: getComputedStyle(document.activeElement).outlineStyle,',
      '}))()',
    ].join('\n'));
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      modifiers: 8,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await connection.command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      modifiers: 8,
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    }, popupIme.sessionId);
    await sleep(50);
    const popupImeShiftTab = await evaluate(connection, popupIme.sessionId, [
      '(() => ({',
      '  activeClass: document.activeElement?.className || "",',
      '  activeIsSearchButton: document.activeElement?.matches(".search-button") || false,',
      '}))()',
    ].join('\n'));
    await evaluate(connection, popupIme.sessionId, 'document.querySelector("[data-target-record-id=\\"r008\\"]")?.click()');
    await waitForCondition(
      connection,
      popupIme.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"r008\\"]")) && document.activeElement?.matches("[aria-label=\\"검색어\\"]")',
    );
    const popupImeRelation = await evaluate(connection, popupIme.sessionId, [
      '(() => ({',
      '  inputFocused: document.activeElement?.matches("[aria-label=\\"검색어\\"]") || false,',
      '  hasBackButton: Boolean(document.querySelector(".back-button")),',
      '}))()',
    ].join('\n'));

    const popupEscape = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupEscape);
    await evaluate(connection, popupEscape.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "담담하다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupEscape.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w026\\"]")) && Boolean(document.querySelector(".search-clear-button"))',
    );
    const popupEscapeFirst = await evaluate(connection, popupEscape.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });',
      '  input.dispatchEvent(event);',
      '  return { defaultPrevented: event.defaultPrevented };',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupEscape.sessionId,
      'document.querySelector("[aria-label=\\"검색어\\"]").value === "" && Boolean(document.querySelector("[data-record-id=\\"w026\\"]"))',
    );
    const popupEscapeAfterFirst = await evaluate(connection, popupEscape.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });',
      '  input.dispatchEvent(event);',
      '  return {',
      '    query: input.value,',
      '    hasRecord: Boolean(document.querySelector("[data-dictionary-record]")),',
      '    hasScrollRegion: Boolean(document.querySelector(".dictionary-scroll-region")),',
      '    hasClearButton: Boolean(document.querySelector(".search-clear-button")),',
      '    secondDefaultPrevented: event.defaultPrevented,',
      '  };',
      '})() ',
    ].join('\n'));
    const popupPendingClear = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupPendingClear);
    await evaluate(connection, popupPendingClear.sessionId, [
      '(() => {',
      '  const originalPostMessage = Worker.prototype.postMessage;',
      '  Worker.prototype.postMessage = function delayedPostMessage(message, transfer) {',
      '    if (message?.method === "search") {',
      '      setTimeout(() => {',
      '        if (transfer === undefined) originalPostMessage.call(this, message);',
      '        else originalPostMessage.call(this, message, transfer);',
      '      }, 250);',
      '      return;',
      '    }',
      '    if (transfer === undefined) return originalPostMessage.call(this, message);',
      '    return originalPostMessage.call(this, message, transfer);',
      '  };',
      '  return true;',
      '})() ',
    ].join('\n'));
    await evaluate(connection, popupPendingClear.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.focus();',
      '  input.value = "담담하다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupPendingClear.sessionId,
      'Boolean(document.querySelector("[data-dictionary-panel][aria-busy=\\"true\\"]"))',
    );
    const popupPendingClearFirst = await evaluate(connection, popupPendingClear.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });',
      '  input.dispatchEvent(event);',
      '  return { defaultPrevented: event.defaultPrevented };',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupPendingClear.sessionId,
      'document.querySelector("[aria-label=\\"검색어\\"]").value === "" && Boolean(document.querySelector(".dictionary-empty-region")) && !Boolean(document.querySelector(".dictionary-empty-region.is-loading"))',
    );
    await sleep(250);
    const popupPendingClearAfter = await evaluate(connection, popupPendingClear.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  return {',
      '    query: input.value,',
      '    hasRecord: Boolean(document.querySelector("[data-dictionary-record]")),',
      '    hasEmptyRegion: Boolean(document.querySelector(".dictionary-empty-region")),',
      '    isLoading: Boolean(document.querySelector(".dictionary-empty-region.is-loading")),',
      '  };',
      '})() ',
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
    const popupRelation = await evaluate(connection, popup.sessionId, [
      '(() => ({',
      '  hasBackButton: Boolean(document.querySelector(".back-button")),',
      '  isRelationTarget: document.querySelector("[data-dictionary-panel]")?.classList.contains("is-relation-target") || false,',
      '  inputFocused: document.activeElement?.matches("[aria-label=\\"검색어\\"]") || false,',
      '  hasCandidateList: Boolean(document.querySelector("[role=\\"listbox\\"]")),',
      '  candidateCount: document.querySelectorAll("[role=\\"option\\"]").length,',
      '  panelHeight: Math.round(document.querySelector("[data-dictionary-panel]").getBoundingClientRect().height),',
      '  resultTop: Math.round(document.querySelector("[data-dictionary-record]").getBoundingClientRect().top),',
      '}))()',
    ].join('\n'));

    const popupPeace = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupPeace);
    await evaluate(connection, popupPeace.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "평온";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupPeace.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w030\\"]"))',
    );
    const popupPeaceLayout = await evaluate(connection, popupPeace.sessionId, [
      '(() => {',
      '  const panel = document.querySelector("[data-dictionary-panel]");',
      '  const region = document.querySelector(".dictionary-scroll-region");',
      '  const result = document.querySelector("[data-dictionary-record]");',
      '  const divider = document.querySelector(".footer-divider");',
      '  return {',
      '    panelHeight: Math.round(panel.getBoundingClientRect().height),',
      '    regionMinHeight: getComputedStyle(region).minHeight,',
      '    regionClientHeight: Math.round(region.clientHeight),',
      '    regionScrollHeight: Math.round(region.scrollHeight),',
      '    footerGap: Math.round((divider.getBoundingClientRect().top - result.getBoundingClientRect().bottom) * 100) / 100,',
      '  };',
      '})() ',
    ].join('\n'));

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
      '  const footer = document.querySelector(".product-footer");',
      '  const searchRow = document.querySelector(".search-row");',
      '  const footerDivider = document.querySelector(".footer-divider");',
      '  const copy = document.querySelector(".state-copy strong");',
      '  const copyBlock = document.querySelector(".state-copy");',
      '  return {',
      '    panelHeight: Math.round(panel.getBoundingClientRect().height),',
      '    bodyHeight: document.body.scrollHeight,',
      '    appHeight: Math.round(document.querySelector("#app").getBoundingClientRect().height),',
      '    footerBottomGap: Math.round((panel.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom) * 100) / 100,',
      '    hasFooter: Boolean(document.querySelector(".product-footer")),',
      '    copy: document.querySelector(".state-copy")?.textContent.trim() || "",',
      '    hasDescription: Boolean(document.querySelector(".state-copy span")),',
      '    hasRetry: Boolean(document.querySelector(".retry-button")),',
      '    stateRegionHeight: Math.round(document.querySelector(".dictionary-state-region").getBoundingClientRect().height),',
      '    copyCenter: copyBlock ? Math.round((copyBlock.getBoundingClientRect().top + copyBlock.getBoundingClientRect().bottom) * 50) / 100 : null,',
      '    emptyAreaMidpoint: searchRow && footerDivider ? Math.round((searchRow.getBoundingClientRect().bottom + footerDivider.getBoundingClientRect().top) * 50) / 100 : null,',
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

    const popupExpression = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupExpression);
    await evaluate(connection, popupExpression.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "마음이 놓이다";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupExpression.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w288\\"]"))',
    );
    const popupExpressionResult = await evaluate(connection, popupExpression.sessionId, [
      '(() => ({',
      '  recordId: document.querySelector("[data-dictionary-record]")?.dataset.recordId || "",',
      '  hasDefinition: Boolean(document.querySelector("[data-group-id=\\"definition\\"]")),',
      '  hasDirectRelation: Boolean(document.querySelector("[data-group-id=\\"synonyms\\"]")),',
      '}))() ',
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
      '  backgroundPresetCount: document.querySelectorAll("[data-background-preset-key]").length,',
      '  selectedBackgroundPreset: document.querySelector("[data-background-preset-key][aria-checked=\\"true\\"]")?.dataset.backgroundPresetKey || "",',
      '  previewBackground: getComputedStyle(document.querySelector(".preview-panel [data-dictionary-panel]")).backgroundColor,',
      '}))()',
    ].join('\n'));
    await evaluate(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]")[0]?.click()',
    );
    await evaluate(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]")[1]?.click()',
    );
    await evaluate(
      connection,
      options.sessionId,
      'document.querySelectorAll("[role=\\"switch\\"]")[4]?.click()',
    );
    await evaluate(
      connection,
      options.sessionId,
      'document.querySelector("[data-background-preset-key=\\"fog\\"]")?.click()',
    );
    await waitForCondition(
      connection,
      options.sessionId,
      'document.querySelector(".preview-panel [data-group-id=\\"texture\\"]") !== null && document.querySelector(".preview-panel [data-group-id=\\"association\\"]") !== null && document.querySelector(".preview-panel [data-group-id=\\"definition\\"]") === null && document.querySelector(".preview-panel [data-group-id=\\"synonyms\\"]") === null && getComputedStyle(document.querySelector(".preview-panel [data-dictionary-panel]")).backgroundColor === "rgb(241, 244, 246)"',
    );
    const optionsPreview = await evaluate(connection, options.sessionId, [
      '(() => {',
      '  const panel = document.querySelector(".preview-panel [data-dictionary-panel]");',
      '  const region = document.querySelector(".preview-panel .dictionary-scroll-region");',
      '  const footer = document.querySelector(".preview-panel .product-footer");',
      '  return {',
      '    panelHeight: Math.round(panel.getBoundingClientRect().height),',
      '    panelWidth: Math.round(panel.getBoundingClientRect().width),',
      '    previewHeight: Math.round(document.querySelector(".preview-panel").getBoundingClientRect().height),',
      '    panelFooterBottomGap: Math.round((panel.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom) * 100) / 100,',
      '    regionClientHeight: Math.round(region.clientHeight),',
      '    regionScrollHeight: Math.round(region.scrollHeight),',
      '    overflowY: getComputedStyle(region).overflowY,',
      '    footerHeight: getComputedStyle(footer).height,',
      '    footerPaddingRight: getComputedStyle(footer).paddingRight,',
      '    backgroundPreset: panel.dataset.backgroundPreset || "",',
      '    backgroundColor: getComputedStyle(panel).backgroundColor,',
      '  };',
      '})() ',
    ].join('\n'));
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
      'document.querySelectorAll("[role=\\"switch\\"]")[0]?.getAttribute("aria-checked") === "false" && document.querySelectorAll("[role=\\"switch\\"]")[1]?.getAttribute("aria-checked") === "false" && document.querySelectorAll("[role=\\"switch\\"]")[4]?.getAttribute("aria-checked") === "true"',
    );
    const optionsReloaded = await evaluate(connection, options.sessionId, [
      '(() => ({',
      '  definitionDisabled: document.querySelectorAll("[role=\\"switch\\"]")[0]?.getAttribute("aria-checked") === "false",',
      '  synonymsDisabled: document.querySelectorAll("[role=\\"switch\\"]")[1]?.getAttribute("aria-checked") === "false",',
      '  textureEnabled: document.querySelectorAll("[role=\\"switch\\"]")[3]?.getAttribute("aria-checked") === "true",',
      '  associationEnabled: document.querySelectorAll("[role=\\"switch\\"]")[4]?.getAttribute("aria-checked") === "true",',
      '  selectedBackgroundPreset: document.querySelector("[data-background-preset-key][aria-checked=\\"true\\"]")?.dataset.backgroundPresetKey || "",',
      '  previewBackground: getComputedStyle(document.querySelector(".preview-panel [data-dictionary-panel]")).backgroundColor,',
      '  hasTextureAfterReload: Boolean(document.querySelector(".preview-panel [data-group-id=\\"texture\\"]")),',
      '  hasAssociationAfterReload: Boolean(document.querySelector(".preview-panel [data-group-id=\\"association\\"]")),',
      '  hasDefinitionAfterReload: Boolean(document.querySelector(".preview-panel [data-group-id=\\"definition\\"]")),',
      '  hasSynonymsAfterReload: Boolean(document.querySelector(".preview-panel [data-group-id=\\"synonyms\\"]")),',
      '}))()',
    ].join('\n'));

    const popupSettings = await createExtensionSession(connection, extensionId, 'popup.html');
    extensionTargets.push(popupSettings);
    await evaluate(connection, popupSettings.sessionId, [
      '(() => {',
      '  const input = document.querySelector("[aria-label=\\"검색어\\"]");',
      '  input.value = "그리움";',
      '  input.dispatchEvent(new Event("input", { bubbles: true }));',
      '  input.dispatchEvent(new KeyboardEvent("keydown", {',
      '    key: "Enter", bubbles: true, cancelable: true,',
      '  }));',
      '  return true;',
      '})() ',
    ].join('\n'));
    await waitForCondition(
      connection,
      popupSettings.sessionId,
      'Boolean(document.querySelector("[data-record-id=\\"w004\\"]"))',
    );
    const popupSettingsResult = await evaluate(connection, popupSettings.sessionId, [
      '(() => ({',
      '  recordId: document.querySelector("[data-dictionary-record]")?.dataset.recordId || "",',
      '  visibleGroups: [...document.querySelectorAll("[data-group-id]")].map((node) => node.dataset.groupId),',
      '  backgroundPreset: document.querySelector("[data-dictionary-panel]")?.dataset.backgroundPreset || "",',
      '  backgroundColor: getComputedStyle(document.querySelector("[data-dictionary-panel]")).backgroundColor,',
      '}))() ',
    ].join('\n'));
    const optionsVersion = await evaluate(connection, options.sessionId, [
      '(() => ({',
      '  rendered: document.querySelector(".brand-version")?.textContent.trim() || "",',
      '  manifest: chrome.runtime.getManifest().version,',
      '  brandMarkRect: (() => { const rect = document.querySelector(".brand-mark").getBoundingClientRect(); return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }; })(),',
      '  brandNameRect: (() => { const rect = document.querySelector(".brand-name").getBoundingClientRect(); return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }; })(),',
      '  brandVersionRect: (() => { const rect = document.querySelector(".brand-version").getBoundingClientRect(); return { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }; })(),',
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
      || popupReady.scrollMinHeight !== '0px'
      || popupReady.panelWidth !== 420
      || popupReady.panelHeight >= 376
      || popupReady.footerHeight !== '20px'
      || popupReady.footerAlignItems !== 'center'
      || popupReady.footerPaddingRight !== '12px'
      || !popupReady.hasClearButton
      || popupReady.runtimeQueryOnly !== 1
      || !popupReady.runtimeWriteBlocked
      || popupReady.runtimePersistedWriteCount !== 0
      || popupReady.definitionTopGap === null
      || popupReady.definitionBottomGap === null
      || Math.abs(popupReady.definitionTopGap - popupReady.definitionBottomGap) > 1
      || focusResult !== 'search-button'
    ) {
      throw new Error('Popup CFT assertions failed: ' + JSON.stringify({ popupReady, focusResult }));
    }
    if (
      JSON.stringify(popupHomonymFirst.optionLabels) !== JSON.stringify(['빛을 받아 사물을 보는 몸의 기관', '하늘에서 내리는 흰 얼음 알갱이'])
      || JSON.stringify(popupHomonymFirst.selectedOptions) !== JSON.stringify(['true', 'false'])
      || popupHomonymFirst.resultCount !== 1
      || JSON.stringify(popupHomonymFirst.visibleSenseIds) !== JSON.stringify(['w133-s1'])
      || popupHomonymFirst.definition !== '빛을 받아 사물을 보는 몸의 기관'
      || popupHomonymFirst.hasBackButton
      || popupHomonymFirst.hasHeaderDivider
      || popupHomonymFirst.candidateDefinitionGap === null
      || Math.abs(popupHomonymFirst.candidateDefinitionGap - 9) > 1
      || JSON.stringify(popupHomonymSecond.selectedOptions) !== JSON.stringify(['false', 'true'])
      || popupHomonymSecond.resultCount !== 1
      || JSON.stringify(popupHomonymSecond.visibleSenseIds) !== JSON.stringify(['w133-s2'])
      || popupHomonymSecond.definition !== '하늘에서 내리는 흰 얼음 알갱이'
      || popupHomonymSecond.hasBackButton
    ) {
      throw new Error('Homonym selection CFT assertions failed: ' + JSON.stringify({ popupHomonymFirst, popupHomonymSecond }));
    }
    if (
      popupImeStart.defaultPrevented
      || popupImeStart.hasRecord
      || popupImeEarly.hasRecord
      || popupImeEarly.inputValue !== 'ㄷ'
      || popupImeKeyboard.defaultPrevented
      || !popupImeKeyboardState.activeIsInput
      || popupImeKeyboardState.activeRecordId !== ''
      || popupImeKeyboardState.activeRole !== ''
      || popupImeKeyboardState.activeSelected !== ''
      || popupImeKeyboardState.candidateCount !== 0
      || popupImeKeyboardState.hasListbox
      || !popupImeTabToButton.activeIsSearchButton
      || !popupImeTab.activeIsRelation
      || popupImeTab.outlineStyle !== 'solid'
      || !popupImeShiftTab.activeIsSearchButton
      || !popupImeRelation.inputFocused
      || !popupImeRelation.hasBackButton
    ) {
      throw new Error('IME/keyboard candidate CFT assertions failed: ' + JSON.stringify({ popupImeStart, popupImeEarly, popupImeKeyboard, popupImeKeyboardState, popupImeTab, popupImeShiftTab, popupImeRelation }));
    }
    if (
      popupEmptyState.panelHeight >= 240
      || popupEmptyState.bodyHeight !== popupEmptyState.panelHeight
      || popupEmptyState.appHeight !== popupEmptyState.panelHeight
      || popupEmptyState.footerBottomGap > 10
      || !popupEmptyState.hasFooter
      || popupEmptyState.copy !== '사전에 없는 말입니다.자주 쓰는 말이라면 등록을 요청해 보세요.'
      || !popupEmptyState.hasDescription
      || popupEmptyState.hasRetry
      || popupEmptyState.stateRegionHeight < 104
      || popupEmptyState.copyCenter === null
      || popupEmptyState.emptyAreaMidpoint === null
      || Math.abs(popupEmptyState.copyCenter - popupEmptyState.emptyAreaMidpoint) > 2
    ) {
      throw new Error('Empty popup sizing CFT assertions failed: ' + JSON.stringify(popupEmptyState));
    }
    if (
      !popupEscapeFirst.defaultPrevented
      || popupEscapeAfterFirst.query !== ''
      || !popupEscapeAfterFirst.hasRecord
      || !popupEscapeAfterFirst.hasScrollRegion
      || popupEscapeAfterFirst.hasClearButton
      || popupEscapeAfterFirst.secondDefaultPrevented
    ) {
      throw new Error('Popup clear/Escape CFT assertions failed: ' + JSON.stringify({ popupEscapeFirst, popupEscapeAfterFirst }));
    }
    if (
      !popupPendingClearFirst.defaultPrevented
      || popupPendingClearAfter.query !== ''
      || popupPendingClearAfter.hasRecord
      || !popupPendingClearAfter.hasEmptyRegion
      || popupPendingClearAfter.isLoading
    ) {
      throw new Error('Pending popup clear CFT assertions failed: ' + JSON.stringify({ popupPendingClearFirst, popupPendingClearAfter }));
    }
    if (
      !popupRelation.hasBackButton
      || !popupRelation.isRelationTarget
      || !popupRelation.inputFocused
      || popupRelation.hasCandidateList
      || popupRelation.candidateCount !== 0
      || popupRelation.panelHeight >= 376
    ) {
      throw new Error('Relation-target layout CFT assertions failed: ' + JSON.stringify(popupRelation));
    }
    if (
      popupPeaceLayout.regionMinHeight !== '0px'
      || popupPeaceLayout.regionScrollHeight > popupPeaceLayout.regionClientHeight + 1
      || popupPeaceLayout.panelHeight >= 376
      || popupPeaceLayout.footerGap > 10
    ) {
      throw new Error('Direct peace-search layout CFT assertions failed: ' + JSON.stringify(popupPeaceLayout));
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
      popupExpressionResult.recordId !== 'w288'
      || !popupExpressionResult.hasDefinition
      || !popupExpressionResult.hasDirectRelation
    ) {
      throw new Error('Expression search CFT assertions failed: ' + JSON.stringify(popupExpressionResult));
    }
    if (
      optionsPreview.regionScrollHeight > optionsPreview.regionClientHeight + 1
      || optionsPreview.overflowY !== 'visible'
      || optionsPreview.panelWidth !== 360
      || optionsPreview.panelHeight >= 258
      || optionsPreview.panelHeight >= optionsPreview.previewHeight
      || optionsPreview.panelFooterBottomGap > 8
      || optionsPreview.footerHeight !== '17.5px'
      || optionsPreview.footerPaddingRight !== '10.5px'
      || optionsPreview.backgroundPreset !== 'fog'
      || optionsPreview.backgroundColor !== 'rgb(241, 244, 246)'
    ) {
      throw new Error('Options preview sizing CFT assertions failed: ' + JSON.stringify(optionsPreview));
    }
    if (
      JSON.stringify(optionsDefault.switches) !== JSON.stringify(['true', 'true', 'false', 'true', 'false'])
      || optionsDefault.previewRecord !== 'preview-w006'
      || optionsDefault.hasAntonymByDefault
      || optionsDefault.backgroundPresetCount !== 6
      || optionsDefault.selectedBackgroundPreset !== 'manuscript'
      || optionsDefault.previewBackground !== 'rgb(246, 243, 238)'
    ) {
      throw new Error('Default Settings CFT assertions failed: ' + JSON.stringify(optionsDefault));
    }
    if (
      !optionsReloaded.definitionDisabled
      || !optionsReloaded.synonymsDisabled
      || !optionsReloaded.textureEnabled
      || !optionsReloaded.associationEnabled
      || optionsReloaded.selectedBackgroundPreset !== 'fog'
      || optionsReloaded.previewBackground !== 'rgb(241, 244, 246)'
      || optionsReloaded.hasDefinitionAfterReload
      || optionsReloaded.hasSynonymsAfterReload
      || !optionsReloaded.hasTextureAfterReload
      || !optionsReloaded.hasAssociationAfterReload
    ) {
      throw new Error('Persisted Settings CFT assertions failed: ' + JSON.stringify(optionsReloaded));
    }
    if (
      popupSettingsResult.recordId !== 'w004'
      || JSON.stringify(popupSettingsResult.visibleGroups) !== JSON.stringify(['texture', 'association'])
      || popupSettingsResult.backgroundPreset !== 'fog'
      || popupSettingsResult.backgroundColor !== 'rgb(241, 244, 246)'
    ) {
      throw new Error('Popup settings reflection CFT assertions failed: ' + JSON.stringify(popupSettingsResult));
    }
    if (optionsDirty.status !== '저장되지 않음' || optionsDirty.saveDisabled) {
      throw new Error('Dirty Settings CFT assertions failed: ' + JSON.stringify(optionsDirty));
    }
    if (
      !optionsVersion.rendered
      || optionsVersion.rendered !== optionsVersion.manifest
      || optionsVersion.brandMarkRect.left !== 48
      || optionsVersion.brandMarkRect.top !== 24
      || optionsVersion.brandMarkRect.width !== 40
      || optionsVersion.brandMarkRect.height !== 40
      || optionsVersion.brandNameRect.left !== 96
      || optionsVersion.brandNameRect.top !== 32
      || optionsVersion.brandVersionRect.left !== 188
      || optionsVersion.brandVersionRect.top !== 36
    ) {
      throw new Error('Options version CFT assertions failed: ' + JSON.stringify(optionsVersion));
    }
    if (nonExtensionRequests.length > 0) {
      throw new Error('Product UI made non-extension requests: ' + JSON.stringify(nonExtensionRequests));
    }

    return {
      extensionId,
      popupReady,
      popupHomonymFirst,
      popupHomonymSecond,
      popupImeStart,
      popupImeEarly,
      popupImeKeyboard,
      popupImeKeyboardState,
      popupImeTab,
      popupImeShiftTab,
      popupImeRelation,
      popupEscapeFirst,
      popupEscapeAfterFirst,
      popupPendingClearFirst,
      popupPendingClearAfter,
      popupRelation,
      popupPeaceLayout,
      popupEmptyState,
      popupLongOverflow,
      popupLongScroll,
      popupExpressionResult,
      focusResult,
      optionsDefault,
      optionsPreview,
      optionsDirty,
      optionsReloaded,
      popupSettingsResult,
      optionsVersion,
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
      await removeTemporaryDirectory(resolvedProfileDirectory);
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
