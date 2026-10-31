#!/usr/bin/env python3
"""
enable_devtools.py – Automatically enables Developer Tools (Console) on Discord
for Windows, macOS, and Linux.

After running this script, restart Discord and press:
- Windows / Linux: Ctrl + Shift + I
- macOS:           Cmd + Option + I
"""

import json
import os
import sys
from pathlib import Path


def get_discord_settings_path() -> Path:
    """Find Discord settings.json path based on current operating system."""
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if not appdata:
            appdata = str(Path.home() / "AppData" / "Roaming")
        return Path(appdata) / "discord" / "settings.json"
    elif sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "discord" / "settings.json"
    else:
        # Linux
        config_home = os.environ.get("XDG_CONFIG_HOME")
        if not config_home:
            config_home = str(Path.home() / ".config")
        return Path(config_home) / "discord" / "settings.json"


def enable_devtools() -> bool:
    settings_path = get_discord_settings_path()
    print(f"[*] Target Discord config: {settings_path}")

    if not settings_path.parent.exists():
        print(f"[!] Discord directory not found at: {settings_path.parent}")
        settings_path.parent.mkdir(parents=True, exist_ok=True)

    data = {}
    if settings_path.exists():
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"[!] Warning reading existing settings ({e}). Creating new configuration.")
            data = {}

    key = "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING"
    if data.get(key) is True:
        print("[OK] Discord DevTools is ALREADY enabled on this device!")
        return True

    data[key] = True

    try:
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print("[OK] Discord DevTools successfully enabled!")
        print("[*] Please fully restart Discord (close from system tray / Cmd+Q) for changes to take effect.")
        return True
    except Exception as e:
        print(f"[ERROR] Failed to save settings: {e}")
        return False


if __name__ == "__main__":
    enable_devtools()

