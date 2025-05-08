<p align="center">
  <img src="images/icon.png" width="100" alt="ZemDomu logo" />
</p>

# ZemDomu

**ZemDomu** is a lightweight VS Code extension that helps you write **semantic HTML** by catching structural issues in real-time. It focuses on accessibility, SEO, and clean markup—without getting in the way.

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

## 🚀 Getting Started

### Install

Coming soon to the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/)!

In the meantime:

1. Clone this repo
2. Run `yarn install`
3. Press `F5` in VS Code to launch the extension host

### Usage

1. Open an `.html`, `.jsx`, or `.tsx` file
2. Save the file
3. Semantic issues appear in the **Problems** tab (`Ctrl+Shift+M`)

---

## ⚙️ Configuration (Coming soon)

Support for `.zemdomurc` config files to enable/disable rules.

---

## 🛠 Development

```bash
yarn install
yarn compile
```

## 📄 License

MIT © 2025 Zacharias Eryd Berlin
