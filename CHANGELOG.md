# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.1 - 2026-08-31

### Fixed

- Fix table in README

## 1.1.0 - 2026-08-26

### Changed

- Simplify round-trip conversion by implementing our own Wasm engine instead of using pre-built Wasm from Tylax
- Use `aligned` instead of `align` for LaTeX

## 1.0.4 - 2026-08-25

### Changed

- Use Enter key for save instead of Alt+Enter. Use Shift+Enter for newlines

### Fixed

- Align popup opening, dismissal, and keyboard shortcuts with RemNote's native LaTeX math editor
- Improve light and dark mode syntax highlighting contrast

## 1.0.3 - 2026-08-24

### Fixed

- Preserve explicit math spaces and text strings during Tylax round-trip conversion
- Normalize relation, underline, and non-breaking-space output during editing

## 1.0.2 - 2026-08-24

### Fixed

- Make Typst editing reliable
- Fix editor rounded corners

## 1.0.1 - 2026-08-23

### Fixed

- Fix stylesheet loading

## 1.0.0 - 2026-08-23

_Initial release._
