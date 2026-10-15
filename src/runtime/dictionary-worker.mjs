import sqlite3InitModule from './vendor/sqlite3.mjs';
import { EXPECTED_DICTIONARY_SOURCE_REVISION } from './dictionary-build-info.js';
import { createDictionaryHost } from './dictionary-host.js';

const host = createDictionaryHost({
  sqlite3InitModule,
  dictionaryUrl: new URL('../dictionary.sqlite', self.location.href),
  expectedSourceRevision: EXPECTED_DICTIONARY_SOURCE_REVISION,
});

self.addEventListener('message', async (event) => {
  const response = await host.handleRequest(event?.data);
  if (response) self.postMessage(response);
});
