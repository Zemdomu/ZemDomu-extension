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

---

## ✨ Features

- 🟢 Warns when `<li>` is not inside `<ul>` or `<ol>`
- 🔵 Ensures correct heading order (`<h1> → <h2> → <h3>`…)
- 🟠 Flags missing `alt` attributes on `<img>`
- 🔴 Detects form fields missing `aria-label` or `<label for="">`
- ⚠️ Highlights empty `<strong>`, `<em>`, and similar tags
- 📛 Verifies `<a>` tags have both `href` and link text
- 📚 Confirms `<section>` includes a heading
- 🧩 Works with `.html`, `.jsx`, and `.tsx` files

---

## ❓ Why ZemDomu?

Most HTML linters focus on syntax or style — **ZemDomu** goes deeper by catching subtle issues that affect:

- **Accessibility** (screen reader compatibility)
- **SEO** (logical heading structure)
- **Semantic structure** (clean, meaningful markup)

It runs automatically on save and integrates into the **Problems tab** for a seamless workflow.

---

## 🚀 Getting Started

### Install

Install directly from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu)

Or search for **ZemDomu** in the VS Code Extensions view.

### Usage

1. Open an `.html`, `.jsx`, or `.tsx` file
2. Save the file
3. Semantic issues appear in the **Problems** tab (`Ctrl+Shift+M`)

---

## ⚙️ Configuration

ZemDomu can be configured through VS Code settings. Search for **ZemDomu** in
the Settings UI or edit `settings.json` directly:

- `zemdomu.run` – control when linting runs (`onSave`, `onType`, `manual`, or
  `disabled`)
- `zemdomu.crossComponentAnalysis` – analyze JSX components across files
- `zemdomu.rules.*` – enable or disable individual semantic rules

---

## 🛠 Development

```bash
npm install
npm run compile
```

## 📄 License

MIT © 2025 Zacharias Eryd Berlin
