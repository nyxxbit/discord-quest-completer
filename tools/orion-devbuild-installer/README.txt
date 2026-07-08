ORION QUESTS - VENCORD AUTO-UPDATE EDITION
===========================================

This is the "heavy but correct" installer. Use it if you want Vencord to
keep auto-updating while the OrionQuests plugin is installed.

How it differs from the simple bundle (orion-vencord-bundle):
  - The simple bundle just copies a prebuilt Vencord over yours. It's tiny and
    instant, but it FREEZES your Vencord version (auto-update is turned off).
  - This edition builds Vencord from source with the plugin baked in, as a real
    git clone. Vencord's updater keeps working: it pulls updates and rebuilds,
    and the plugin is recompiled back in every time. Auto-update stays alive.

The tradeoff: this is a bigger install. It downloads Node build dependencies
(a few hundred MB) and takes a couple of minutes.


------------------------------------------------------------
INSTALL
------------------------------------------------------------
  1. Double-click INSTALL-autoupdate.cmd
  2. If it says Node.js or Git is missing, let it install them (it uses winget).
     If a prompt appears, click Allow / Yes. If it asks you to close and re-run
     after installing them, do that.
  3. When it patches Discord, Windows or your antivirus may ask permission -
     choose Allow / Run. (It's editing Discord's own files, which is normal for
     any Vencord install.)
  4. When it finishes, Discord reopens. Go to Settings -> Plugins, search
     OrionQuests, and enable it. For achievement quests, also enable the
     "achievementBypass" toggle (off by default).


------------------------------------------------------------
IMPORTANT
------------------------------------------------------------
  - It installs into:  %LOCALAPPDATA%\OrionVencord
    (usually C:\Users\<you>\AppData\Local\OrionVencord)
    DO NOT move or delete that folder. Discord loads Vencord from it. If you
    delete it, Discord will fail to start Vencord until you reinstall.

  - Vencord updates itself normally after this (Settings -> Vencord -> Updater).
    Each update rebuilds the plugin back in automatically.


------------------------------------------------------------
UNINSTALL
------------------------------------------------------------
  - Double-click UNINSTALL.cmd. It unpatches Discord and you can then delete
    the OrionVencord folder.
  - Or run the official Vencord installer (vencord.dev/download) and pick
    Uninstall.


------------------------------------------------------------
NOTES
------------------------------------------------------------
  - Using mods on Discord violates the Terms of Service. The ban risk is yours.
  - Project source: github.com/nyxxbit/discord-quest-completer
  - Version: v4.9.5
