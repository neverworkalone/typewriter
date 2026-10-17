import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { PRODUCT_UNIT_TEST_FILES } from './scripts/ci/product-unit-test-files.mjs';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: PRODUCT_UNIT_TEST_FILES,
  },
});
