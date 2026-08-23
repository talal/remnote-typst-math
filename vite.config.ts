import { defineConfig } from 'vite-plus';

const commonIgnorePatterns = [
  '.agents/**',
  '.github/**',
  'dist/**',
  'public/wasm/**',
  'PluginZip/**',
  'PluginZip.zip',
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
