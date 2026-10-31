# Project Context – Discord Quest Completer

## Layout & Components
- [`quest_script.js`](../quest_script.js): Standalone console script running inside Discord's developer console (or via Vencord / Tampermonkey).
- [`enable_devtools.py`](../enable_devtools.py): Multi-platform utility to find and update Discord's `settings.json` to enable DevTools access.
- [`README.md`](../README.md): Quick start guide and platform instructions for Windows and macOS.
- [`LICENSE.md`](../LICENSE.md): MIT License.

## Verification & Execution Flow
- DevTools shortcut:
  - Windows/Linux: `Ctrl + Shift + I`
  - macOS: `Cmd + Option + I`
- Script execution:
  - Pasted into Discord DevTools Console tab.
  - Renders an interactive modal inside Discord listing active promotional quests.
  - Emits real-time progress updates, triggers automated enrollment, and claims rewards upon completion.
