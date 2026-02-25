# ⚡ Orion - Enterprise Discord Quest Completer

> **The ultimate automated tool for completing Discord Quests effortlessly.**
> Featuring a hybrid execution engine, smart traffic control system, and a stunning, persistent in-app dashboard.

![Version](https://img.shields.io/badge/version-3.7-blue.svg?style=flat-square)
![Status](https://img.shields.io/badge/status-stable-success.svg?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## 🚀 Key Features

### 🛡️ Core Stability & Stealth
* **Hybrid Execution Engine (v3.7):** Runs video tasks in parallel (up to 2x) for speed, while safely queuing game/stream tasks serially (1x) to mimic real human behavior and prevent detection.
* **Dynamic Metadata Fetching:** Queries Discord's API to fetch the actual executable name, icon, and game ID. No more generic "game.exe" – the Rich Presence looks exactly like a native game launch.
* **Anti-Hang Protocols:** Features a 25-minute safety timeout to prevent infinite loops (Zombie Promises) if Discord fails to send a progress heartbeat.
* **Traffic Control System (Anti-429):** Intelligent request queuing prevents "Too Many Requests" API bans. It buffers actions with a safety delay to ensure 100% completion success without network errors.

### 💎 User Experience (UX)
* **Global Kill Switch [STOP]:** A true shutdown button. Instantly halts the event loop, clears all game patches, and cancels pending network requests without leaving background processes.
* **Draggable Dashboard:** The UI is no longer fixed. You can drag the panel anywhere on your screen.
* **State Persistence:** Orion remembers exactly where you left the window. Close Discord, reopen it, run the script, and the panel reappears in the same spot.
* **Auto-Enroll & Loop:** Automatically accepts new quests and continuously loops until all rewards are claimed.

---

## 🔓 Prerequisites: Enabling the Console

By default, the Developer Console is locked on the stable version of Discord.

### Option A: Use Discord Canary (Recommended)
Download **[Discord Canary](https://canary.discord.com/download)**. The console is enabled by default.

### Option B: Unlock on Standard Discord
1.  Fully close Discord.
2.  Press `Win + R`, type `%appdata%/discord`, and press Enter.
3.  Open `settings.json`.
4.  Add this line inside the brackets:
    `"DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true`
5.  Save and restart Discord.

---

## 🛠️ Installation & Usage

1.  **Copy** the entire code from the [index.js file](https://github.com/nyxxbit/discord-quest-completer/blob/main/index.js).
2.  Open **Discord** and press `Ctrl + Shift + I` (or `F12`) to open the Console.
3.  **Paste** the code and hit **Enter**.
4.  Sit back! The **Orion UI** will appear.

> **Tip:** You can toggle the UI visibility by pressing `Shift + .` (Greater Than symbol).

## ⚙️ Configuration

You can tweak the internal settings at the top of the script code before pasting:

```javascript
const CONFIG = {
    VIDEO_SPEED: 5,               // Seconds of progress per tick
    HIDE_ACTIVITY: false,         // Hide the "Playing..." status from friends
    GAME_CONCURRENCY: 1,          // Recommended value: 1. Increase at your own risk
    REQUEST_DELAY: 1500,          // Delay between API calls (Anti-429)
    MAX_TASK_TIME: 25 * 60 * 1000 // 25-minute safety timeout
};
```

## ⚠️ Disclaimer

This tool is for **educational purposes only**. Automating user actions violates Discord's Terms of Service.
The developer (**syntt_**) is not responsible for any account suspensions or bans resulting from the use of this software. Use at your own risk.

---

<div align="center">
  <b>Developed with ❤️ by <a href="https://discord.com/users/1419678867005767783">syntt_</a></b>
</div>
