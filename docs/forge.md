# Forge on the game page

Five features that live on Steam's own library pages rather than in the
Quick Access Menu, plus save backups through Ludusavi before mod changes
and per-game OptiScaler. Built on Windows (Decky Loader in Steam Big
Picture, started by Core), and nothing in them is Windows-only except the
crash report check and OptiScaler's GPU lookup.

| Piece | Frontend | Backend |
|---|---|---|
| Mods section on the game page | `src/gamePagePatch.tsx`, `src/GameModsSection.tsx` | `forge_game_status` |
| Anti-cheat lock | the section's locked state | `py_modules/forge_guard.py`, wrappers at the end of `main.py` |
| Way back after a crash | `src/forge.ts` (game start/exit), the section's offer | `forge_guard_*` |
| Update dots on tiles | `src/forge.ts` (one stylesheet) | `forge_update_dots`, cache filled by `check_updates` too |
| Steam collection "Modded" | `src/moddedSync.ts`, rules in `src/moddedCollection.ts` | `forge_note_modded`, `forge_modded_state`, `forge_set_modded_collection`, the `forge_mods_changed` event |
| Save backups (Ludusavi, optional) | `src/SaveBackup.tsx`, the section's save line | `py_modules/save_backup.py`, `forge_save_*`, `_wrap_save_backups` in `main.py`, the `forge_save_backup` event |
| Upscaling (OptiScaler) | `UpscalingEntry` in `src/GameModsSection.tsx`, run watch in `src/optiscaler.ts` | `py_modules/optiscaler.py`, `forge_optiscaler_*` and `_wrap_optiscaler_refusal` in `main.py` |

Pure rules are in `src/forgeRules.ts` (tested by `tests/forge.test.mjs`),
`src/moddedCollection.ts` (tested by `tests/moddedCollection.test.mjs`)
`py_modules/forge_guard.py` (tested by `tests/test_forge.py`) and
`py_modules/optiscaler.py` (tested by `tests/test_optiscaler.py`). The
save backups are tested by `tests/test_save_backup.py` against a fake
`ludusavi` that answers like the real one's `--api` mode.

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

`InnerContainer` is found by its class from `appDetailsClasses`, looked up
through `src/gamePageAnchor.ts`: the named `@decky/ui` export, else
`findClassModule`, else `findVar` (only in `@decky/ui` 5). The loader supplies
`@decky/ui`: 4.x under Decky 3.3.1, 5.x under Decky 4.0, whose Steam client
renamed nearly all classes and whose class names are pinned per Steam build.
When the class is missing or stale, the section goes into whichever children
array holds the overview panel. No overview panel, no section.

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

It also covers the paths whose game is in saved state rather than in the
call: finishing a parked FOMOD (`install_fomod`, `install_fomod_auto`,
checked when it finishes, so a lock turned back on after the token was made
still applies), the crash hunt (`crash_bisect_start` / `_apply` / `_finish`,
from the hunt's state), Saints Row 2's GotR options (on), script-extender
DLLs coming back, `set_mod_option`, and the load-order writers that can
switch entries back on. `tests/test_forge.py` (`StructuralGateTests`)
enumerates every backend callable and fails unless it is gated or on an
allow-list of read-only, switch-off, remove and bookkeeping calls, each
group with its reason.

The gate fails closed. The game is resolved from the call's app id, then
the backend's own records (domains the frontend registered, the app ids
restore points recorded, experimental games, and the Steam library
manifests for an install folder). When none of them names the game, or the
lookup throws, the call is refused with `"reason": "game_unknown"` and a
message saying Forge could not tell which game it is. A folder walk that
throws for a known game falls back to the list, so a listed game stays
locked.

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
page puts it back. The record is cleared only when every change of the undo
went through; if any was refused (a locked game, a busy folder) it stays,
the toast names what was not restored, and Undo can be tried again (it then
switches only what still differs). A clean run, a new change to the mods, or **Not now**
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

## Save backups before mod changes (Ludusavi)

Forge can back a game's saves up with
[Ludusavi](https://github.com/mtkennerly/ludusavi) (MIT) before it changes
that game's mods. Ludusavi is **optional** and is never installed by Forge:

```
winget install -e --id mtkennerly.ludusavi
```

### Finding it

`ludusavi` / `ludusavi.exe` on the loader's PATH first, then the places a
loader started before the install would not see on PATH: winget's
`%LOCALAPPDATA%\Microsoft\WinGet\Links` and
`Packages\mtkennerly.ludusavi_*` (the winget package is a portable zip,
command alias `ludusavi`), the same under `%ProgramFiles%\WinGet`, and
Scoop's `apps\ludusavi\current` and `shims` (under `%SCOOP%` or
`%USERPROFILE%\scoop`, and `%SCOOP_GLOBAL%` or `%ProgramData%\scoop`). The
answer is cached for five minutes; Settings looks again when it opens.

Without it, Settings shows one line (*Install Ludusavi to back up saves
before mod changes*), the game page says nothing about saves, and nothing
else changes.

### When a backup runs

- **Before every call that puts mods in or switches them on** for a game:
  the same list the anti-cheat lock guards (`_FORGE_GATED`, the "on"
  direction only), so installs, collections, frameworks, enabling a mod or
  all mods, load-order writers and the rest are covered wherever they are
  started from. Switching off and uninstalling never back up. The wrapper
  sits **inside** the anti-cheat lock: a call the lock refuses backs up
  nothing.
- **Before the crash guard's restore and before Undo**, from the game page
  (`forge_save_backup`).
- **Before a save restore**, always (see below).

A backup for a game is **skipped** when one for that game already ran (worked
or not) within the window: 30 minutes by default, 0 to 120 in Settings. A
collection of 300 mods is one backup, and a broken Ludusavi is not retried
before each of them. Concurrent calls for one game wait for the one backup
in progress.

**Time box: 60 seconds** for the title lookup and the backup together. When
it runs out Ludusavi is stopped (`subprocess.run(timeout=...)` kills it).
**A backup never blocks the mod change**: a timeout, a crash, files Ludusavi
could not read, an unknown game, or an error inside Forge's own code is
logged, sent as a `forge_save_backup` event (one small toast, *Save backup
failed ... The mod change went ahead.*), and the call goes on. Ludusavi runs
with `CREATE_NO_WINDOW`: it is a console program and would otherwise flash a
window over the game.

### Ludusavi's command line (checked against v0.31.0)

All in `--api` mode (JSON on stdout; stdout can be blank on some errors,
stderr carries human-readable warnings). `--try-manifest-update` keeps an
offline PC working, since Ludusavi otherwise fails when its manifest
download fails.

| Step | Command |
|---|---|
| Ludusavi's name for the game | `ludusavi --try-manifest-update find --api --steam-id <app id>`, then by the exact Steam name, then `--normalized` (a name matching more than one title is not used). Non-Steam shortcuts (app ids with the top bit set) skip the Steam id. Remembered in `forge.json` for a week, a miss for a day |
| Backup | `ludusavi --try-manifest-update backup --force --api <title>`. Worked when `games.<title>.decision` is `Processed`, no file has `failed`, and `errors.someGamesFailed` is unset. No save files found counts as worked (nothing to lose). A failed cloud sync still counts: the local copy is made |
| List | `ludusavi backups --api <title>` -> `games.<title>.backups[]` with `name` (the id), `when` (RFC 3339, UTC), `comment`, `locked`, `os` |
| Restore | `ludusavi --try-manifest-update restore --force --api --backup <id> <title>` |

Backups go to the folder **Ludusavi's own configuration** names; Forge
passes no `--path` and never edits the config. Cloud sync follows Ludusavi's
setting too. With `--force`, a cloud conflict is left alone rather than
resolved (Ludusavi's own behaviour). One trade-off: if a cloud upload is
still running when the 60-second box ends, Ludusavi is stopped mid-sync and
will report the cloud as out of step the next time it runs.

### Game page and Settings

With Ludusavi installed, the Mods section shows **Last save backup:
12 min ago** (or *No save backup yet*), an amber *Save backup failed* when
the latest attempt did not work, and **Restore saves...**. Both also show on
anti-cheat locked games: a backup only reads the game, and a restore puts
saves back, not mod files.

**Restore saves...** lists Ludusavi's backups of the game, newest first, and
restores one only after a confirmation. The backend refuses without that
confirmation flag, then takes a **fresh backup of the current saves first**
(the switch and the skip window do not apply to this one); if that backup
fails, nothing is restored. The frontend also refuses while the game is
running.

Settings, under **Game page**: **Back up saves before mod changes** (on by
default; kept in `forge.json` because the backend acts on it) and the skip
window. The restore's own backup runs even with the switch off.

**Not verified on a TV or a real Ludusavi yet**: the command lines and the
JSON fields come from Ludusavi's documentation and source (v0.31.0), and the
tests run against a fake that answers the same way. Check on the PC that a
Steam game's title is found by its id, that a backup appears in Ludusavi's
folder, and that the restore list matches Ludusavi's own.

## Upscaling (OptiScaler)

An entry in the game page's Mods section, **Upscaling (OptiScaler)**, that
puts [OptiScaler](https://github.com/optiscaler/OptiScaler) into one game:
it takes the upscaler a game already offers (DLSS, FSR 2/3 or XeSS) and
runs another one in its place. Shown wherever the section is (managed games,
the any-game setup offer, locked games).

### Licence and source

- OptiScaler is **GPL-3.0** (its `LICENSE`, checked 2026-11-26 at upstream
  `a1e0e19`). Forge is BSD-3-Clause / MIT, so Forge **never ships or vendors
  OptiScaler**: the user's own PC downloads the official release at install
  time, the same way a user would by hand. Nothing in
  `py_modules/optiscaler.py` is taken from OptiScaler's code or from Clarity
  (GPL-3.0, Windows-native, AMD-only, used as reference only); the module is
  written from OptiScaler's public docs: the wiki's *Manual Installation*
  page and the `OptiScaler.ini` shipped with a release.
- Source of the download: `https://api.github.com/repos/optiscaler/OptiScaler/releases/latest`
  (the newest non-pre-release release; pre-releases and nightlies are never
  offered). Only an asset whose URL starts with
  `https://github.com/optiscaler/OptiScaler/releases/download/` is accepted.
- Asset: the first asset named `OptiScaler*.7z` (else `*.zip`), skipping
  debug / symbols / source builds. Releases publish a 7z such as
  `Optiscaler_0.9.0-final.20260401._AF.7z` (v0.9.0, as named in Decky-Framegen's
  release notes); latest tags at the time of writing are `v0.9.4` (July) and
  `v0.9.5` (2026-11-15). The exact asset list of v0.9.5 could not be read
  from here (GitHub's API was not reachable from the build machine), so the
  name match is deliberately loose. Unpacked with Forge's usual extractors
  (`_extract_sync`: 7-Zip / bsdtar).

### Hash

GitHub's API gives every release asset a `digest` (`sha256:<hex>`). When it
is there the download must match it, or it is deleted and nothing is
installed (`digest_mismatch`; accepting a change never overrides a published
digest). When it is not, the first hash Forge sees for that release asset
(`<tag>/<asset name>`) is pinned in `forge.json` (`optiscaler.pins`); the
same asset with a different hash later is refused with a warning, and the
game page asks *Install anyway?* before retrying with `accept_new_hash`
(re-pinned). The archive is kept in `runtime/optiscaler/<tag>/` (newest
release only), so reinstalling under another name or upscaler does not
download again; it is re-hashed every time.

### Anti-cheat: refused, no override

OptiScaler is a DLL loaded into the game's process; to an anti-cheat that is
injection. `optiscaler.refusal` refuses, with the crimson
**Not allowed: anti-cheat (DLL injection)** and no override button:

- every game the anti-cheat lock detects (the list, `EXTRA_GAMES`, and the
  anti-cheat files in the game folder), **including games where the user
  turned on "Allow mods anyway"**: the override is read as "detected", not
  "unlocked";
- the lock's `ONLINE_ONLY` games, and `optiscaler.COMPETITIVE` (Dota 2,
  Deadlock, Team Fortress 2, Counter-Strike, Counter-Strike: Source): ranked
  online VAC games the mod list leaves out on purpose. VAC bans injected
  DLLs (AMD's Anti-Lag+ got Counter-Strike 2 players banned in October 2023);
- a game Forge cannot identify (fails closed).

`forge_optiscaler_install` and `forge_optiscaler_set_upscaler` are also in
`_FORGE_GATED` (so `StructuralGateTests` and the Modded events see them), but
`_wrap_optiscaler_refusal` puts OptiScaler's own check outside the ordinary
lock so a locked game gets the OptiScaler wording. The refusal comes before
any download, backup or file work. Removal is never refused.

### Install

In order, each step able to stop it with nothing touched:

1. the refusal above;
2. the game folder (registered games, then Steam's app manifest) and its exe:
   the plugin's `processName` when the game is managed, else an Unreal
   `*-Win64-Shipping.exe`, else the biggest exe that is not a launcher, crash
   handler, installer or tool, outside `Engine/` and redistributable folders
   (`optiscaler.pick_exe`); the exe is remembered in the record;
3. *Close the game first* if it is running;
4. **DirectX check** from the exe's import table (`reloaded_ii.pe_info`):
   refused for a 32-bit exe or one that imports only DirectX 8/9 or OpenGL;
   `d3d12` / `d3d11` / `vulkan-1` are recorded; an exe that imports none
   (d3d12 loaded at run time, common in Unreal) is allowed;
5. **GPU check**: `Win32_VideoController` names and PnP ids through
   PowerShell (`CREATE_NO_WINDOW`, 20 s, cached a day). FSR 4 is offered only
   for RDNA 4 (Radeon RX 9000 / AI PRO R9000, PCI ids 7550/7551/7590), DLSS
   only on NVIDIA; FSR 3.1 and XeSS always. Default: FSR 4 on RDNA 4, DLSS on
   NVIDIA, XeSS on Arc, else FSR 3.1;
6. download and hash (above), unpack;
7. a **Ludusavi backup** of the saves (`_saves_backup`, the same switch and
   skip window as mod installs; a failed backup never stops the install). It
   is taken here, not by `_wrap_save_backups`, so a refused or failed check
   backs nothing up;
8. the files: a previous OptiScaler install of the game is taken out first
   (update, other upscaler, other name), then every file of the release goes
   next to the exe, `OptiScaler.dll` renamed to the proxy name, except the
   shipped `OptiScaler.ini` (Forge writes its own), `setup_windows.bat`,
   `setup_linux.sh`, the remove scripts and the "extract all files" readme.
   All or nothing: a failure part way removes what was copied and puts the
   originals back.

**Proxy name** (`optiscaler.choose_proxy`): `dxgi.dll`, `winmm.dll`,
`version.dll` in that order (dxgi is OptiScaler's preferred name; the wiki
also lists d3d12, dbghelp, wininet, winhttp and `.asi`, not offered). The
first name not present in the exe's folder wins. A ReShade DLL Forge put
there is never replaced; nor is a file that already has a `.nexusbak`
beside it (another mod's backup would be lost: the install is refused).
When all three are taken, the first one that is neither is replaced. The
game page offers **Use winmm.dll instead** (and so on round) for games that
do not load the current one.

**Backups**: any game file the install replaces (a `dxgi.dll`, the game's
own `libxess.dll` or `amd_fidelityfx_dx12.dll`, an older `OptiScaler.ini`)
is set aside as `<file>.nexusbak`, the files-mode backup every Forge
install uses, and listed in the record. The record lives in `forge.json`
under `optiscaler.games.<app id>`: every file with its SHA-256, the backups,
the folders created, the exe, the proxy, upscaler, version, asset, hash and
how it was checked.

**Remove** deletes each file only while it still has the hash Forge
recorded (a file another mod replaced since is left and named), puts every
`.nexusbak` back where the path is free (`_restore_backups`), and removes the
folders it created if empty. When something had to be left, the record keeps
just that, so Remove can be pressed again. The round-trip test compares the
whole game folder, byte for byte, before install and after removal.

### OptiScaler.ini

A minimal file, CRLF, only the keys Forge sets; every other key takes
OptiScaler's default (`auto`):

| Choice | `[Upscalers]` Dx11 / Dx12 / Vulkan | `[FSR] UpscalerIndex` |
|---|---|---|
| FSR 4 | `fsr31_12` / `fsr31` / `fsr31_12` | `0` (FSR 4) |
| FSR 3.1 | `fsr31` / `fsr31` / `fsr31` | `1` (FSR 3.1) |
| XeSS | `xess_12` / `xess` / `xess` | - |
| DLSS | `dlss` / `dlss` / `dlss` | - |

All three APIs are written because Forge cannot always tell which one a
game uses. The names are those of the v0.9.x releases (`fsr31`,
`fsr31_12`). OptiScaler's development branch renamed them `ffx` / `ffx_12`;
Forge reads the comment above `Dx12Upscaler=` in the release's own shipped
ini and uses `ffx` names when that is what it documents
(`optiscaler.upscaler_family`). `[Menu] DisableSplash=true` hides
OptiScaler's startup splash, its "press Insert" hint; the overlay itself
stays on Insert. **Upscaler...** on the game page rewrites only the ini.

### Failure safety

`src/optiscaler.ts` sends the start and exit of every run of a game with
OptiScaler in (any game, managed or not) to the backend. Until the first
clean run after an install or update, a Windows Error Reporting crash report
for the exe (`forge_guard.wer_crashed`, the crash guard's check) or a run
under 60 seconds marks OptiScaler **suspect**: one toast (opens the game
page) and a crimson box with **Remove OptiScaler** (one press) and **Keep
it** (stops watching). A clean run ends the watch.

### Not verified on the PC yet

Everything here ran against fake files, a fake release and a fake extractor
on Linux. On the PC, check: that the real v0.9.5 asset is picked and its
GitHub digest matches; that the 7z unpacks with the bundled extractor; that
the game loads OptiScaler under `dxgi.dll` (Insert opens its menu even with
the splash hidden); that the minimal ini is honoured (the FSR 4 watermark,
`Fsr4EnableWatermark=true` added by hand, confirms FSR 4); that PowerShell
reports the GPU name; and that a game crash shows the removal offer.
