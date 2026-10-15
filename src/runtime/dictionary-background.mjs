import sqlite3InitModule from './vendor/sqlite3.mjs';
import { EXPECTED_DICTIONARY_SOURCE_REVISION } from './dictionary-build-info.js';
import { createDictionaryHost } from './dictionary-host.js';
import { BACKGROUND_PORT_NAME } from './protocol.js';

// MV3 service workers cannot spawn Workers, so the database is hosted here and
// shared by every popup. The service worker may be suspended at any time; the
// host reloads the database lazily on the next request.
const host = createDictionaryHost({
  sqlite3InitModule,
  dictionaryUrl: new URL('../dictionary.sqlite', self.location.href),
  expectedSourceRevision: EXPECTED_DICTIONARY_SOURCE_REVISION,
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BACKGROUND_PORT_NAME) return;

  port.onMessage.addListener(async (request) => {
    const response = await host.handleRequest(request);
    if (!response) return;
    try {
      port.postMessage(response);
    } catch {
      // The popup disconnected before the response was ready.
    }
  });
});
