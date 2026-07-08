ORION QUESTS - VENCORD AUTO-UPDATE EDITION
===========================================

This is the "heavier but correct" installer. Use it if you want Vencord to
keep auto-updating while the OrionQuests plugin is installed.

How it differs from the simple bundle (orion-vencord-bundle):
  - The simple bundle copies a prebuilt Vencord over yours. Tiny and instant,
    but it FREEZES your Vencord version (auto-update is turned off).
  - This edition builds Vencord from source with the plugin baked in, as a real
    git clone. Vencord's updater keeps working: it pulls updates and rebuilds,
    and the plugin is recompiled back in every time. Auto-update stays alive.


------------------------------------------------------------
WHAT TO EXPECT (read this so you don't panic)
------------------------------------------------------------
  - It takes about 5 to 15 minutes and downloads roughly 300 MB.
  - It will sit on "Installing dependencies" with fast scrolling text for a
    while. THAT IS NORMAL. Do NOT close the window - closing it mid-way leaves
    a half-finished install.
  - Needs Node.js 22+ and Git. If they're missing, the installer permanently
    installs them system-wide via winget, and each shows its own "Do you want
    to allow changes?" (UAC) box - click Yes.


------------------------------------------------------------
INSTALL
------------------------------------------------------------
  1. Double-click INSTALL-autoupdate.cmd
  2. If it installs Node.js / Git, allow the UAC prompts (Yes). If it asks you
     to close and re-run afterwards, do that.
  3. When it patches Discord, Windows may show a full-screen blue box:
     "Windows protected your PC". Click "More info", then "Run anyway".
     This is Vencord's own installer, freshly downloaded from GitHub; Windows
     flags it only because it's new/unsigned. If it ever names a publisher
     other than Vencord, stop.
  4. When it finishes, Discord reopens. Go to Settings -> Plugins, search
     OrionQuests, and enable it. For achievement quests, also enable the
     "achievementBypass" toggle (off by default).


------------------------------------------------------------
IMPORTANT
------------------------------------------------------------
  - It installs into:  %LOCALAPPDATA%\OrionVencord
    (usually C:\Users\<you>\AppData\Local\OrionVencord)
    DO NOT move or delete that folder. Discord loads Vencord from it. If you
    delete it while it's installed, Discord won't start (see RECOVERY below).

  - Vencord updates itself normally after this (Settings -> Vencord -> Updater).
    If an update ever says "Build failed", run UPDATE.cmd from this folder - it
    does the full rebuild the in-app updater can't.


------------------------------------------------------------
UNINSTALL
------------------------------------------------------------
  - Double-click UNINSTALL.cmd. It restores Discord to normal, then you can
    delete the OrionVencord folder. (Node.js and Git stay installed; UNINSTALL
    tells you how to remove those too if you want.)


------------------------------------------------------------
RECOVERY (if something goes wrong)
------------------------------------------------------------
  - If Discord won't open: go to
    %LOCALAPPDATA%\Discord\app-<version>\resources
    delete "app.asar", and rename "_app.asar" to "app.asar".
    Discord will open normally again (without the plugin). Then you can re-run
    INSTALL-autoupdate.cmd if you want it back.
  - If an update says "Build failed": run UPDATE.cmd.
  - If the OrionVencord folder got into a weird state: delete it and re-run
    INSTALL-autoupdate.cmd.
  - Last resort: run the official Vencord installer (vencord.dev/download) and
    pick Uninstall or Repair.


------------------------------------------------------------
NOTES
------------------------------------------------------------
  - Using mods on Discord violates the Terms of Service. The ban risk is yours.
  - Project source: github.com/nyxxbit/discord-quest-completer
  - Version: v4.9.5
