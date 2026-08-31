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
  - Before installing Node/Git or downloading Vencord, it checks which Discord
    flavor will be patched. A usable target must have both an active app-* tree
    and Discord's Update.exe; stale leftover Discord folders are ignored.
  - It will sit on "Installing dependencies" with fast scrolling text for a
    while. THAT IS NORMAL. Do NOT close the window.
  - The Vencord build is transactional. After each successful managed build,
    the installer writes a SHA-256 health stamp for patcher.js, preload.js,
    renderer.js, and renderer.css. A previous dist is rollback-eligible only if
    those hashes still match, OrionQuests is present, and patcher/preload/renderer
    identify the same Vencord revision. A half-written or externally rebuilt dist
    is never silently promoted to "known good" just because its files exist.
  - Needs Node.js 22+ and Git. If they're missing, the installer permanently
    installs them system-wide via winget, and each shows its own "Do you want
    to allow changes?" (UAC) box - click Yes.
  - Node 25+ is supported. If Node does not include Corepack, the installer uses
    npx with the exact pnpm version declared by Vencord instead.


------------------------------------------------------------
INSTALL
------------------------------------------------------------
  1. Double-click INSTALL-autoupdate.cmd
  2. If it installs Node.js / Git, allow the UAC prompts (Yes). If it asks you
     to close and re-run afterwards, do that.
  3. If you have multiple Discord flavors installed, the installer prefers the
     single flavor that is currently running. If that is still ambiguous it asks
     you to choose stable, canary, or ptb instead of silently assuming Stable.
     Advanced use: INSTALL-autoupdate.cmd -DiscordBranch canary
     You can also use INSTALL-autoupdate.cmd -SkipInject to build without patching
     Discord. The .cmd wrapper forwards these options to the PowerShell installer.
     The flavor that is actually patched is always reopened; any other Discord
     flavor that was already running is reopened too.
  4. When it patches Discord, Windows may show a full-screen blue box:
     "Windows protected your PC". Click "More info", then "Run anyway".
     This is Vencord's own installer, freshly downloaded from GitHub; Windows
     flags it only because it's new/unsigned. If it ever names a publisher
     other than Vencord, stop.
  5. When it finishes, Discord reopens. Go to Settings -> Plugins, search
     OrionQuests, and enable it. For achievement quests, also enable the
     "achievementBypass" toggle (off by default).

If the installer says Orion was installed but Discord did not reopen, start the
named client manually. If it still will not start, run the official Vencord
installer and choose Repair before retrying Orion.


------------------------------------------------------------
IMPORTANT
------------------------------------------------------------
  - It installs into:  %LOCALAPPDATA%\OrionVencord
    (usually C:\Users\<you>\AppData\Local\OrionVencord)
    DO NOT move or delete that folder. Discord loads Vencord from it. If you
    delete it while it's installed, Discord won't start (see RECOVERY below).

  - Keep this extracted installer folder if you want to use UPDATE.cmd or
    UNINSTALL.cmd later. Those scripts depend on the helper files beside them.

  - Vencord updates itself normally after this (Settings -> Vencord -> Updater).
    IMPORTANT: Vencord's in-app updater rebuilds the live dist directly and does
    not update Orion's health stamp. If it ever says "Build failed", DO NOT close
    or restart Discord first. While the current Discord session is still open,
    run UPDATE.cmd from this installer folder. The managed updater installs
    dependencies and rebuilds transactionally. If the live dist no longer matches
    the last managed health stamp, it is not used as rollback state; a successful
    managed build creates a fresh stamp.

  - UPDATE.cmd and UNINSTALL.cmd preserve the Discord flavor(s) that were open.
    They do not replace Canary/PTB with Stable just because Stable is installed,
    and they leave Discord closed if it was already closed.

  - Reopening Discord is verified. If Windows/Squirrel accepts the start command
    but the Discord process never appears, the script reports a warning instead
    of silently printing success as if the client reopened normally.

  - If Discord refuses to close within 15 seconds, install/update/uninstall stops
    instead of modifying files while the client is still alive. Close Discord
    manually and retry.

  - WHEN DISCORD ITSELF UPDATES, Vencord normally carries the patch over on its
    own: it notices the new version as Discord is closing and re-applies itself.
    That only works if Discord shuts down properly, so if Discord was force-closed
    (Task Manager, a crash, or the PC cutting out) the patch can be left behind in
    the old version's folder and the plugin will be gone on next launch. Nothing is
    broken and nothing is lost - run INSTALL-autoupdate.cmd again from this
    installer folder to re-patch the new version while reusing everything already
    downloaded.


------------------------------------------------------------
UNINSTALL
------------------------------------------------------------
  - Run UNINSTALL.cmd from this installer folder. It restores Discord to normal,
    then you can delete the OrionVencord folder. (Node.js and Git stay installed;
    UNINSTALL tells you how to remove those too if you want.)


------------------------------------------------------------
RECOVERY (if something goes wrong)
------------------------------------------------------------
  - If Discord won't open, use the root for the flavor you patched:
      Stable:  %LOCALAPPDATA%\Discord\app-<version>\resources
      Canary:  %LOCALAPPDATA%\DiscordCanary\app-<version>\resources
      PTB:     %LOCALAPPDATA%\DiscordPTB\app-<version>\resources

    IMPORTANT: check that "_app.asar" exists AND is not 0 bytes BEFORE changing
    anything. A missing or empty _app.asar is not a safe recovery copy.

    If _app.asar exists and is non-empty:
      1. Rename the current "app.asar" to "app.asar.orion-broken"
         (do NOT delete it first).
      2. Rename "_app.asar" to "app.asar".
      3. Start Discord. If it opens normally, you may delete
         "app.asar.orion-broken" afterwards.

    If _app.asar is missing or empty, do not delete or rename app.asar. Run the
    official Vencord installer (vencord.dev/download) and choose Repair/Uninstall.
    This avoids turning a recoverable install into one with no usable app.asar.

  - If managed UPDATE.cmd says the Vencord build failed, a previous dist is only
    restored automatically when it still matches the SHA-256 health stamp from a
    successful managed build. An unverified mixed/externally rebuilt dist is never
    used as rollback just because all four filenames exist.
  - If the in-app updater says "Build failed", keep the current Discord session
    open and run the managed UPDATE.cmd before the next Discord restart.
  - If the OrionVencord folder got into a weird state: do NOT delete it while
    Discord still points at it. First run the official Vencord installer and
    choose Repair/Uninstall, confirm Discord opens normally, then delete it.
  - Last resort: run the official Vencord installer (vencord.dev/download) and
    pick Uninstall or Repair.


------------------------------------------------------------
NOTES
------------------------------------------------------------
  - Using mods on Discord violates the Terms of Service. The ban risk is yours.
  - Project source: github.com/nyxxbit/discord-quest-completer
  - Version: v4.10.8