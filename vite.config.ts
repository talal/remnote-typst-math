import { defineConfig } from 'vite-plus';

const commonIgnorePatterns = [
  '.agents/**',
  '.github/**',
  'dist/**',
  'public/wasm/**',
  'PluginZip/**',
  'PluginZip.zip',
  // Vendored upstream crate: keep byte-identical to its source release so
  // deltas stay auditable; never reformat or lint it.
  'crates/engine/third_party/**',
];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  fmt: {
    ignorePatterns: [...commonIgnorePatterns],
    singleQuote: true,
  },
  lint: {
    ignorePatterns: [...commonIgnorePatterns],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
