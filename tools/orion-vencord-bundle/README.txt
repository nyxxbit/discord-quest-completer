==============================================================
                  ORION QUESTS - READ ME
==============================================================

Auto-complete Discord quests. Works with every type:
- Video (watch a trailer)
- Game (play X minutes)
- Stream (share your screen)
- Activity (be in a call with an activity)
- Achievement (in-game milestone) <- the hard one, already solved


==============================================================
                    QUICK INSTALL
==============================================================

1) INSTALL VENCORD (once, skip if you already have it)
   - Open your browser
   - Go to: https://vencord.dev/download
   - Download the Windows installer
   - Run it and click "Install"
   - Let it restart Discord if it asks

2) INSTALL ORIONQUESTS
   - DOUBLE-CLICK "INSTALL.cmd" (included in this zip)
   - Wait for it to finish (a black window opens)
   - It handles everything: closes Discord, copies the files,
     reopens Discord

3) ENABLE THE PLUGIN IN DISCORD
   - In Discord, open Settings (the gear at the bottom)
   - Scroll to the "Vencord" section (left menu)
   - Click "Plugins"
   - Search for "OrionQuests"
   - Turn the toggle on (blue button)
   - If a "Restart" or "Reload" button shows up, click it


==============================================================
                       HOW TO USE
==============================================================

In any Discord channel, type:

  /orion start    -- start auto-completing all quests
  /orion stop     -- stop
  /orion status   -- see which quests it's working on

The browser console (Ctrl+Shift+I in Discord) shows the
detailed log if you want to follow along.


==============================================================
                  COMMON PROBLEMS
==============================================================

"The installer told me to install Vencord first"
  Do step 1 of QUICK INSTALL above, then run INSTALL.cmd again.

"OrionQuests doesn't show up in the Plugins list"
  Make sure you fully closed Discord FROM THE SYSTEM TRAY
  (right-click the icon near the clock -> Quit Discord).
  Just closing the window isn't enough.

"The plugin is on but /orion start does nothing"
  Press Ctrl+R in Discord to reload.

"Activity quest won't complete, error 50165"
  You need to age-verify on Discord for that specific
  Activity. Go to User Settings -> Privacy & Safety ->
  and verify your age.

"After updating Vencord the plugin disappeared"
  The official Vencord installer overwrote our files.
  Just run INSTALL.cmd again.


==============================================================
                  IMPORTANT WARNINGS
==============================================================

* Using mods on Discord violates the Terms of Service. The
  ban risk is YOURS. There are reports of warnings after
  April 2026, and enforcement can hit the whole account.

* The Achievement bypass authorizes the quest's app on your
  account via OAuth to report progress, then revokes it right
  after. If that worries you, skip it on your main account.

* The plugin only completes quests YOU already have on your
  account. It can't pull rewards that weren't offered to you.

* Project source: github.com/nyxxbit/discord-quest-completer
