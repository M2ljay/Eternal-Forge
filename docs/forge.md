# Forge on the game page

Five features that live on Steam's own library pages rather than in the
Quick Access Menu. Built on Windows (Decky Loader in Steam Big Picture,
started by Core), and nothing in them is Windows-only except the crash
report check.

| Piece | Frontend | Backend |
|---|---|---|
| Mods section on the game page | `src/gamePagePatch.tsx`, `src/GameModsSection.tsx` | `forge_game_status` |
| Anti-cheat lock | the section's locked state | `py_modules/forge_guard.py`, wrappers at the end of `main.py` |
| Way back after a crash | `src/forge.ts` (game start/exit), the section's offer | `forge_guard_*` |
| Update dots on tiles | `src/forge.ts` (one stylesheet) | `forge_update_dots`, cache filled by `check_updates` too |
| Steam collection "Modded" | `src/moddedSync.ts`, rules in `src/moddedCollection.ts` | `forge_note_modded`, `forge_modded_state`, `forge_set_modded_collection`, the `forge_mods_changed` event |

Pure rules are in `src/forgeRules.ts` (tested by `tests/forge.test.mjs`),
`src/moddedCollection.ts` (tested by `tests/moddedCollection.test.mjs`)
and `py_modules/forge_guard.py` (tested by `tests/test_forge.py`).

The frontend parts can be switched off in the plugin's Settings, under
**Game page**.

## The Mods section

Steam's game page is `/library/app/:appid`. Like ProtonDB Badges and HLTB
for Deck, the plugin adds a `routerHook.addPatch` on that route, follows
`renderFunc` with `createReactTreePatcher`, and splices one element into the
app details `InnerContainer`, directly before Steam's own overview panel
(the play section and the tabs). The overview panel is recognised by the
props it is rendered with (`overview`, `details`, `bFastRender`), the same
shape HLTB for Deck keys on.

It shows, for a game the plugin manages: how many mods are on, how many
have an update, up to six mods (updates first, then the ones that are on)
with a switch each, **Open** / **Update** to go to the mod's page in the
plugin, **Add mods** (the plugin's store for that game), **Show all** and
**My Mods**. Pages opened from here go back to the game page on B, not to
the Quick Access Menu (`pushFromGamePage` in `src/Tabs.tsx`).

For a game the plugin does not manage it shows nothing, unless the
experimental any-game mode is on, in which case it offers to set the game
up (from the Quick Access Menu).

### Failing safe

The page belongs to Steam, so every failure leaves it as Steam drew it:

- each step of the patch is in a `try`; a failure returns Steam's tree
  unchanged;
- the section renders inside an error boundary that renders nothing on an
  error;
- after three failures of either kind in a session the patch stops touching
  the page until the plugin reloads (`FailureBudget`);
- when the overview panel is not found (soundtracks, tools, a Steam update
  that moved things) nothing is inserted;
- the section never takes focus. Play keeps the page's first focus; the
  section is one press up from it, and works with the D-pad and A alone;
- the route patch is removed when the plugin unloads.

## Anti-cheat lock

Games with an anti-cheat that runs on the player's PC are locked: the
section explains why, offers to switch any installed mods **off**, and every
backend call that puts mod files into the game or switches mods **on** is
refused with `{"ok": false, "anticheat_locked": true, "error": ...}`. That
covers `install_mod`, collection installs, frameworks, prefix tools, mod
programs, ReShade, mod setups, `set_mod_enabled` (on), `set_all_mods_enabled`
(on), plugin and framework switches, and the rest listed in `_FORGE_GATED`.
Switching off and uninstalling are never refused. The refusal runs before
the restore point and before any file work.

The QAM shows the same locked state and the same two buttons at the top of
the game's sections (`ForgeLockSection` in `src/ForgeLock.tsx`). The QAM's
other install buttons (Step 1 frameworks, collection and mod installs) are
not individually hidden; while the game is locked the backend refuses them
with the lock message.

Where the verdict comes from, in order:

1. **Per-game override.** Off by default, offered for **every** locked
   game, online-only ones included, and it is **one press**: no dialog.
   The risk is on the button and in the locked text instead:
   - games with an offline or anti-cheat-off mode (`OFFLINE_CAPABLE`: Elden
     Ring, Nightreign, Dark Souls III, Armored Core VI, GTA V, Halo MCC) read
     *"Allow mods anyway - play modded offline only"*;
   - everything else (online-only titles in `ONLINE_ONLY` such as Call of
     Duty, Counter-Strike 2, Rainbow Six Siege, Apex, Marvel Rivals, and any
     game found only by its anti-cheat files) reads *"Allow mods anyway -
     may get this account banned"*.
   While it is on, the section and the QAM say so and offer **Lock mods
   again**. The override is a flag in the backend's state file, and that
   flag is what the install gate reads, so the frontend cannot unlock a
   game any other way.
2. **The list.** `py_modules/anticheat_games.json`, 500 Steam app ids with
   a client-side anti-cheat, generated by `tools/make_anticheat_list.py`
   from [AreWeAntiCheatYet](https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet)'s
   `games.json` (MIT, (c) 2021 Starz0r, Curve; source hash and date are in
   the file). Kept: Easy Anti-Cheat, BattlEye, GameGuard, XIGNCODE3,
   Ricochet, Vanguard, FACEIT, EA Javelin, ACE, NetEase and similar. Left
   out on purpose: VAC and PunkBuster (Left 4 Dead 2 and Garry's Mod are
   mod-first games) and FairFight (server side only - Battlefront II has
   nothing else). `EXTRA_GAMES` adds a few the list lacks (GTA V Enhanced,
   Overwatch 2, Counter-Strike 2, Warframe).
3. **Files in the game folder.** The marker names Core's Gaming Mode agent
   uses for its anti-cheat safe mode
   (`Source/GamingModeAgent/GamingMode.Services/AntiCheatProtection.cs`,
   `AntiCheatCatalog.FolderMarkers`): `EasyAntiCheat`, `BattlEye`,
   `start_protected_game.exe`, `randgrid.sys`, `EAAntiCheat.*.exe`,
   `GameGuard`, `XIGNCODE` and the rest. The game folder and its direct
   subfolders are read by name only, and the result is cached ten minutes.

Steam's store pages carry a kernel anti-cheat disclosure since October
2024, but the client exposes no documented field for it to plugins, so it
is not used.

What this means for supported games: **Elden Ring** (EAC) and **Helldivers
2** (GameGuard) are locked until the override is turned on for them.
Elden Ring's modded launches already run offline through ME3, so it gets
the offline wording; Helldivers 2 is online-only and gets the ban wording.

To regenerate the list: download `games.json` from the repository above and
run `python tools/make_anticheat_list.py path/to/games.json`.

## Way back after a crash

At every game start the plugin records the set of mods that are on
(`forge_guard_launch`). At exit (`forge_guard_exit`) the run is:

- **clean**: it lasted at least 60 seconds and Windows wrote no crash report
  for the game. Its mod set becomes the *last known good* set;
- **failed**: it ended within 60 seconds, or Windows Error Reporting wrote
  an `AppCrash_<exe>` report for one of the game's executables while it ran
  (`%ProgramData%` and `%LOCALAPPDATA%` `\Microsoft\Windows\WER\ReportArchive`
  and `ReportQueue`, folder names and times only). Steam tells plugins only
  that a game started and stopped (`SteamClient.GameSessions.
  RegisterForAppLifetimeNotifications`, `{unAppID, bRunning}`), never an
  exit code.

A failure only counts when the mods that were on differ from the last known
good set (otherwise going back changes nothing). Two failures in a row
after a mod change make the offer: **one** notification ("Restore last
working mods?", which opens the game page), and a box in the game page's
Mods section until it is answered.

Restoring switches mods installed since the good run **off** and mods that
were on then back **on**, through `install.ts` like every other switch.
Nothing is uninstalled or deleted; a mod removed since stays removed and is
named. With no clean run on record the way back is every mod off. The set
from before the restore is kept for a week, and **Undo restore** on the game
page puts it back. A clean run, a new change to the mods, or **Not now**
ends the streak.

Starting the game twice within 15 seconds with the same mods (a launcher
handing over) counts as one start.

## Update dots

A small crimson dot on library and home tiles of games with mod updates.

Data: `forge_update_dots` computes updates from the install records and a
cache of Nexus versions (`runtime/forge-update-cache.json`) with the same
rules as the Updates page (collection pins respected, companion files follow
their parent, an ignored version stays ignored). With `refresh`, games
whose cache is older than **six hours** are fetched again, **three games per
call** at most, and calls that reach Nexus at least **20 seconds** apart; a
game with no tracked mods is never fetched. Every `check_updates` the plugin
already runs (Updates page, QAM) refreshes the same cache for free. The
frontend asks a minute after start and then every 30 minutes; an install or
a switch recounts from the cache without the network.

Drawing: one `<style>` element in Steam's main window (`findSP()`), CSS
only. A tile's capsule image carries its app id in its URL
(`/<appid>/library_600x900`, `/<appid>/library_capsule`, custom art
`<appid>p.<ext>`), and `:has()` puts the dot on the image's wrapper. A Steam
update that renames these makes the selector match nothing: the dots
disappear and no tile breaks. The element is removed on unload and when the
setting is off. The game page shows the same count as a chip whatever
happens to the tiles.

**Not verified on a TV yet**: whether the dot lands in the tile's top-right
corner depends on the wrapper being positioned in Steam's current markup.
If it lands somewhere odd, switch it off in Settings; the counts stay on
the game page.

## The Modded collection

A Steam collection called **Modded** holding every game that has at least
one mod on through Forge: a mod the plugin installed (tracked) that is
switched on, loose-file mods without a switch included. A folder the plugin
found but did not install does not count. A game goes in when that becomes
true and comes out when it stops being true, whichever way the mods went
off: a switch, Disable all, an uninstall, a reset, the crash guard's
restore, or the anti-cheat lock's "switch mods off".

### When it is updated

- **At load**, 20 seconds after the plugin starts (so Steam has loaded its
  collections first), every managed game is recounted. Games whose domain
  has no install records are counted as 0 without being read.
- **After every mod change.** Every backend call that can put a mod in,
  switch one, or take one out (the `_FORGE_GATED` list plus uninstalls,
  resets, FOMOD installs, parking and disabling failing mods/plugins) ends
  with a `forge_mods_changed` event naming the game's domain and app id.
  The wrapper is applied last, so a call the anti-cheat gate refused sends
  nothing. The frontend collects the games that changed and, once nothing
  has changed for **2 seconds**, recounts only those games; an event with no
  domain recounts every game. Runs never overlap. A collection install of
  hundreds of mods is one reconcile at the end, not hundreds.
- **When the switch is turned back on.**

Counting is `get_installed_mods` per game, the same read My Mods does, so
disk is the truth. It is all local: no Nexus call is made, and it works
offline. A count that cannot be read (the call failed) keeps what was known
for that game rather than taking it out.

The backend keeps the result in `runtime/forge.json`: `modded`
(`{app_id: {domain, on, at}}`, games with at least one mod on) and
`collection` (the record below). The Steam side is done from the frontend
with Steam's `collectionStore`, like The Collector does it:
`NewUnsavedCollection` + `AsDragDropCollection().AddApps` + `Save` to
create, `AddApps` / `RemoveApps` + `Save` to update, `Delete` to remove.
Nothing writes Steam's files.

### Ownership

Forge touches exactly one collection: the one whose Steam id it recorded
when it created it (`collection.id` in `forge.json`).

- **Found by id, never by name.** A collection called "Modded" is Forge's
  only if its id is the recorded one. A user's own "Modded" is never
  changed, filled or deleted.
- **Name clash.** When Forge has to create its collection and "Modded" is
  taken (Steam compares names case-insensitively), it creates **Modded
  (Forge)** instead (then "Modded (Forge 2)", and so on) and records the
  clash. Settings says so: *a collection called "Modded" already existed
  and is yours, so Forge left it alone.*
- **Only Forge's games come out.** The record lists the games Forge itself
  added (`collection.added`). A game is only ever removed if it is on that
  list. A game the user put in by hand stays, modded or not; a modded game
  that was already there by hand is not claimed.
- **Created only when needed**: nothing is created while no game is
  modded. Once made, the collection stays even when it is empty.
- **Renamed** by the user: still Forge's (same id), and Settings shows the
  new name.
- **Deleted** in Steam: Forge forgets the record and makes a new one the
  next time a game is modded (while the switch is on).
- **Taken out by hand** while still modded: it is put back at the next
  reconcile. To stop that, turn the switch off.

### Settings

Under **Game page**:

- **Keep a Modded collection** (on by default). Turning it off stops the
  updates and leaves the collection exactly as it is; nothing is deleted.
  The backend keeps counting, so turning it back on is right straight away.
- **Remove Modded collection** deletes Forge's own collection (found by its
  recorded id), and nothing else, then forgets it. It also turns the switch
  off, or the collection would come back with the next mod change. The row
  names Forge's collection and any name clash.

**Not verified on a TV yet**: that `collectionStore.userCollections` is
complete 20 seconds after load on every start (a user's "Modded" that has
not loaded yet would look like a free name), and that a collection's `id`
is set once `Save()` has returned (the code falls back to finding it by its
new name).
