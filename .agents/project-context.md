# Project Context – Discord Quest Completer

## Layout & Components
- [`quest_script.js`](../quest_script.js): Standalone console script running inside Discord's developer console (or via Vencord / Tampermonkey).
- [`enable_devtools.py`](../enable_devtools.py): Multi-platform utility to find and update Discord's `settings.json` to enable DevTools access across Windows, macOS, and Linux.
- [`README.md`](../README.md): Quick start guide, feature matrix, and platform instructions for Windows and macOS.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): Contribution guidelines and architecture standards.
- [`LICENSE.md`](../LICENSE.md): MIT License.

## Key Features & Execution Model
- **Cross-Platform**: Seamless support for macOS and Windows.
- **Parallel Game Quests**: Executes multiple game quests simultaneously in parallel (default 15 concurrent, uncapped), drastically reducing total wait time.
- **In-Memory Store Patching**: Patches Discord's `RunningGameStore` in memory to safely trigger Discord's native heartbeat engine without writing fake `.exe` files to disk.
- **Instant Video Tasks**: Automatically submits completion timestamps for video-based quests in seconds.
- **Auto-Enroll & Auto-Claim**: Automates the entire lifecycle from quest enrollment to claiming final rewards and Orbs.
- **Audio Completion Cue**: Built-in Web Audio API chime sounds upon cycle completion (enabled by default).
- **Direct Quests Navigation**: 1-click button routes natively to Discord's `/quest-home` tab.
