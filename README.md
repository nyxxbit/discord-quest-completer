# ⚡ Orion - Enterprise Discord Quest Completer

> **The ultimate automated tool for completing Discord Quests effortlessly.**
> Featuring a hybrid execution engine, traffic control system, and a stunning in-app overlay UI.

![Version](https://img.shields.io/badge/version-3.5-blue.svg?style=flat-square)
![Status](https://img.shields.io/badge/status-working-success.svg?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green.svg?style=flat-square)

---

## 🚀 Key Features

* **Hybrid Execution Engine:** Runs video tasks in parallel for speed, while safely queuing game/stream tasks serially to prevent detection and errors.
* **Traffic Control System (Anti-429):** Intelligent request queuing prevents "Too Many Requests" API bans by respecting rate limits automatically.
* **Invisible Overlay Bypasser:** Simulates full game processes with metadata to trick Discord's internal detection without needing to download actual games.
* **Visual Dashboard:** Injects a beautiful, draggable overlay into Discord to track progress in real-time with custom SVG icons and progress bars.
* **Auto-Enroll & Loop:** Automatically accepts new quests, handles "Select Platform" glitches, and loops until all rewards are claimed.

---

## 🔓 Prerequisites: Enabling the Console

By default, the Developer Console is locked on the stable version of Discord. You have two options to access it:

### Option A: Use Discord Canary (Recommended)
The easiest way is to download **[Discord Canary](https://canary.discord.com/download)**.
This is the developer build of Discord, where the console is enabled by default.

### Option B: Unlock on Standard Discord
If you prefer using your standard Discord client, follow these steps to manually unlock the DevTools:

1.  Fully close Discord (ensure it's not running in the system tray).
2.  Press `Win + R` on your keyboard.
3.  Type `%appdata%/discord` and press Enter.
4.  Open the file named `settings.json` using Notepad or any text editor.
5.  Add the following line inside the curly brackets `{ ... }`:

    "DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING": true,

    *(Make sure to add a comma at the end of the previous line if necessary).*

6.  Save the file and restart Discord.

---

## 🛠️ Installation & Usage

1.  Open **Discord** in your browser or Desktop Client.
2.  Open the **Developer Console**:
    * Windows/Linux: `Ctrl + Shift + I`
    * Mac: `Cmd + Option + I`
3.  Paste the script code into the **Console** tab and hit **Enter**.
4.  Sit back! The **Orion UI** will appear in the top-right corner.

> **Tip:** You can toggle the UI visibility by pressing `Shift + .` (Greater Than symbol).

## ⚙️ Configuration

You can tweak the internal settings at the top of the script code before pasting:

```javascript
const CONFIG = {
    VIDEO_SPEED: 5,        // Seconds of progress per tick
    GAME_CONCURRENCY: 4,   // Max simultaneous games (Recommended: 4)
    FAKE_ACTIVITY: true    // Show "Playing..." status to friends
};
```

## ⚠️ Disclaimer

This tool is for **educational purposes only**. Automating user actions violates Discord's Terms of Service.
The developer (**syntt_**) is not responsible for any account suspensions or bans resulting from the use of this software. Use at your own risk.

---

<div align="center">
  <b>Developed with ❤️ by <a href="[https://discord.com/users/1419678867005767783](https://discord.com/users/1419678867005767783)">syntt_</a></b>
</div>