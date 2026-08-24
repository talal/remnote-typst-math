module.exports = {
  content: ['./src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--rn-font-family)'],
        serif: ['var(--rn-font-family)'],
        mono: [
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          '"PT Mono"',
          '"Liberation Mono"',
          'Courier',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
