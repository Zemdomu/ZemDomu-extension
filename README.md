<p align="center">
  <img src="images/icon.png" width="100" alt="ZemDomu logo" />
</p>

<h1 align="center">ZemDomu</h1>

<p align="center">
  <em>Semantic HTML linting for a cleaner, more accessible web</em>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu">
    <img src="https://img.shields.io/visual-studio-marketplace/v/ZachariasErydBerlin.zemdomu?label=VS%20Code" alt="VS Code Marketplace" />
  </a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

---

## 🧠 What is ZemDomu?

**ZemDomu** is a VS Code extension that **lints for semantic HTML issues**, going beyond syntax to catch deeper structural and accessibility problems in your HTML, JSX, and TSX files.

It runs automatically on save and integrates with the **Problems tab** and inline diagnostics to help you build better markup, instantly.

---

## ✨ Features

* 🔍 Warns when `<li>` is outside a `<ul>` or `<ol>`
* 🧫 Enforces correct heading levels (`<h1>` → `<h2>` → ...)
* 🖼 Flags missing `alt` on `<img>`
* 🧠 Requires accessible text on `<button>`
* 🔒 Checks that `<iframe>` has a `title`
* 🌍 Requires `lang` attribute on `<html>`
* 📸 Validates `alt` on `<input type="image">`
* 🧾 Detects form controls without `aria-label` or `<label for="">`
* 🆔 Warns on duplicate `id` attributes
* 💬 Highlights empty semantic tags (`<strong>`, `<em>`, etc.)
* 🔗 Flags `<a>` tags missing `href` or visible text
* 🧹 Ensures every `<section>` has a heading
* 🧽 Warns if `<nav>` contains no links
* 🧠 Cross-component JSX analysis
* ⚡ Caching for fast re-linting
* 🛠 Quick fixes for common issues

---

## 🌟 Why Use ZemDomu?

Most linters focus on **syntax** or **style**. ZemDomu catches **semantic violations** that impact:

* **Accessibility** – screen reader & assistive tech compatibility
* **SEO** – semantic structure and crawlability
* **UX** – cleaner, more consistent user experiences

---

## 🚀 Getting Started

### 🔧 Installation

* Install via [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu)
* Or search for `ZemDomu` inside the VS Code Extensions panel

### ⚙️ Usage

1. Open any `.html`, `.jsx`, or `.tsx` file
2. Make changes and save
3. Issues show up instantly in:

   * **Problems tab** (`Ctrl+Shift+M`)
   * Red squiggly underlines in the editor

---

## 🛠 Configuration

Customize how ZemDomu behaves through the VS Code **Settings UI** or your `settings.json`.

#### 🔀 Lint Trigger

```json
"zemdomu.run": "onSave" // other options: "onType", "manual", "disabled"
```

#### 🧹 Cross-Component Analysis

```json
"zemdomu.crossComponentAnalysis": true
```

#### 🧪 Rule Toggle

Enable/disable specific rules:

```json
"zemdomu.rules.enforceHeadingOrder": true
"zemdomu.rules.requireAltText": false
```

#### 🧃 Inline Disabling (HTML/JSX)

```html
<!-- zemdomu-disable-next -->
<!-- zemdomu-disable -->
<!-- zemdomu-enable -->
```

```jsx
{/* zemdomu-disable-next */}
```

---

## 📌 Related

* [Extension Page](https://marketplace.visualstudio.com/items?itemName=ZachariasErydBerlin.zemdomu)
* [Issues & Suggestions](https://github.com/Zelcus/ZemDomu/issues)
* [Contribution Guide](https://github.com/Zelcus/ZemDomu#contributing)

---

## 📄 License

MIT © 2025 [Zacharias Eryd Berlin](https://github.com/Zelcus)
