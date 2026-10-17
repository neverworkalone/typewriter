// Only durable product behavior and package contracts enter automatic Vitest CI.
// One-off implementation/style checks stay outside this list and are run directly when needed.
export const PRODUCT_UNIT_TEST_FILES = Object.freeze([
  'tests/candidate-label.test.js',
  'tests/dictionary-host.test.js',
  'tests/dictionary-runtime-assets.test.js',
  'tests/domain.test.js',
  'tests/meaning-order.test.js',
  'tests/product-manifest.test.js',
  'tests/product-output-contract.test.js',
  'tests/product-shell.test.js',
  'tests/query-adapter.test.js',
  'tests/relation-paging.test.js',
  'tests/settings.test.js',
  'tests/web-app.test.js',
]);
