# Contributing to Discord Quest Completer (Orion)

Thank you for your interest in contributing! This project is maintained to provide a fast, reliable, zero-install Discord Quest automation suite running natively in Discord Desktop.

---

## 🚀 Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork**:
   ```bash
   git clone https://github.com/akm1311/orbshacker.git
   cd orbshacker
   ```
3. **Create a topic branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Make your changes**:
   - Primary script: [`quest_script.js`](./quest_script.js) (JavaScript / Discord Webpack store patches)
   - Setup utility: [`enable_devtools.py`](./enable_devtools.py) (Python 3.10+)
5. **Commit your changes**:
   ```bash
   git commit -m "feat: describe your change cleanly"
   ```
6. **Push to your fork & open a Pull Request**:
   ```bash
   git push origin feature/your-feature-name
   ```

---

## 🛠️ Development & Architecture Standards

### In-Client Console Script (`quest_script.js`)
- **Runtime**: Runs directly in Discord's Chromium/Electron developer console.
- **Language**: Modern ES6+ JavaScript (`"use strict"`).
- **Zero External Spoofing**: Do not introduce fake binary executables (`.exe`) or filesystem pollers. Automation must operate via Discord's internal stores (`RunningGameStore`, `QuestStore`, `FluxDispatcher`, `RestAPI`).
- **Safety & Privacy**: Never commit or log Discord tokens, authentication cookies, or personal system file paths.
- **Cross-Platform Compatibility**: Ensure features work identically on both macOS and Windows Discord Desktop clients.

### Toolchain & Formatting
- Code syntax should be verified using Bun or Node:
  ```bash
  bun -e "new Function(require('fs').readFileSync('quest_script.js', 'utf8'))"
  ```
- Keep console styling CSP-safe and DOM manipulation clean.

---

## 📋 Pull Request Guidelines

1. **Test locally in Discord**: Verify your changes in Discord Desktop with DevTools enabled (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> on Windows, <kbd>Cmd</kbd> + <kbd>Option</kbd> + <kbd>I</kbd> on macOS).
2. **Document changes**: Update [`README.md`](./README.md) or agent guidelines if you change configuration defaults or add supported quest types.
3. **Keep PRs atomic**: One feature, bug fix, or quest handler enhancement per PR.

---

## 🐛 Reporting Issues

When reporting an issue, please provide:
- **Operating System**: (e.g. Windows 11, macOS Sequoia Apple Silicon)
- **Discord Version / Channel**: (Stable, PTB, or Canary)
- **Quest Name & Task Type**: (e.g. Play Game, Stream, Watch Video, Activity)
- **Console Log Output**: Redact any personal account tags or IDs before posting.
