# Operating Standards & Agent Directives

## Architecture & Project Scope
- This repository provides an in-client Discord Quest automation solution via [`quest_script.js`](../quest_script.js) and support utilities.
- External executable spoofers (e.g. creating fake `.exe` files on disk) have been eliminated in favor of direct in-memory store patching within Discord Desktop.

## Development & Runtime Standards
1. **Target Environment**:
   - Discord Desktop Client (Windows & macOS Electron builds).
   - Python 3.10+ (for standalone setup utilities like [`enable_devtools.py`](../enable_devtools.py)).
   - Bun 1.4+ for any JS/TS toolchain commands.
2. **Discord Console Script Practices**:
   - The script hooks into Discord's Webpack internal modules (`RunningGameStore`, `QuestStore`, `FluxDispatcher`, `RestAPI`).
   - For `PLAY_ON_DESKTOP` and `STREAM_ON_DESKTOP` tasks, Discord's internal store is patched with the target application ID, prompting Discord's native quest manager to emit signed heartbeats.
   - For `WATCH_VIDEO` tasks, instant completion payloads are dispatched to `/quests/{id}/video-progress`.
   - **Parallel Game Tasks**: Supports executing game tasks concurrently in parallel (`GAME_CONCURRENCY = 15 default, uncapped`), allowing multiple games to accumulate quest minutes at the exact same time without waiting sequentially.
   - Never write binary executables or fake game processes to user desktop folders.
