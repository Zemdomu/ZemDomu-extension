<p align="center">
  <img src="images/icon.png" width="100" alt="ZemDomu logo" />
</p>

<h1 align="center">ZemDomu</h1>

<p align="center">
  <em>Semantic HTML linting for a cleaner, more accessible web</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/visual-studio-marketplace/v/ZachariasErydBerlin.zemdomu?label=VS%20Code" alt="VS Code Marketplace">
</p>

# ZemDomu User Guide

ZemDomu is a Visual Studio Code extension that provides semantic HTML linting. It helps catch common accessibility and structural issues in HTML, JSX and TSX files.

## Features

- Warns when `<li>` is not inside `<ul>` or `<ol>`
- Ensures correct heading order (`<h1>` → `<h2>` → `<h3>`…)
- Flags missing `alt` attributes on `<img>`
- Ensures `<button>` elements have accessible text
- Requires `<iframe>` tags to include a `title`
- Enforces `lang` on the `<html>` element
- Checks `<input type="image">` for `alt` text
- Detects form fields missing `aria-label` or `<label for="">`
- Warns when multiple elements share the same `id`
- Highlights empty `<strong>`, `<em>`, and similar tags
- Verifies `<a>` tags have both `href` and link text
- Confirms `<section>` includes a heading
- Warns if `<nav>` contains no links
- Works with `.html`, `.jsx` and `.tsx` files
- Caches results so subsequent saves only re-check the current file
- Quick fixes for simple issues like missing `alt` attributes

## Why ZemDomu?

Most HTML linters focus on syntax or style. **ZemDomu** goes deeper by catching subtle issues that affect:

- **Accessibility** — screen reader compatibility
- **SEO** — logical heading structure
- **Semantic structure** — clean, meaningful markup

It runs automatically on save and integrates into the **Problems** tab for a seamless workflow.

## Getting Started

### Install

Install directly from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu).

Or search for **ZemDomu** in the VS Code Extensions view.

### Usage

1. Open an `.html`, `.jsx`, or `.tsx` file.
2. Save the file.
3. Semantic issues appear in the **Problems** tab (`Ctrl+Shift+M`).

## Configuration

ZemDomu can be configured through VS Code settings. Search for **ZemDomu** in the Settings UI or edit `settings.json` directly:

- `zemdomu.run` – control when linting runs (`onSave`, `onType`, `manual`, or `disabled`)
- `zemdomu.crossComponentAnalysis` – analyze JSX components across files
- `zemdomu.rules.*` – enable or disable individual semantic rules

### Inline Rule Controls

You can selectively disable ZemDomu using special comments:

- `<!-- zemdomu-disable-next -->` – skip linting for the next element
- `<!-- zemdomu-disable -->` – start a block where linting is disabled
- `<!-- zemdomu-enable -->` – re-enable linting after a disabled block

For JSX/TSX files use the JSX comment syntax, e.g. `{/* zemdomu-disable */}`.

## License

MIT © 2025 Zacharias Eryd Berlin
