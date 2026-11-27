# Forge: Decky Loader Plugin (Unofficial)

**Forge** is a fork of [decky-nexus](https://github.com/RedRanger14/decky-nexus)
by RedRanger14 (Michael Finney), the Nexus Mods plugin for Decky Loader, with
experimental support for any game, GameBanana as a second mod source, and
Windows (Steam Big Picture) support. The rest of this README is upstream's,
with this fork's additions in the "Fork" section at the end. The licence is
upstream's (see [License](#license)).

Upstream base: **v1.21.40** (the part of the version before `-anygame`).
On Windows, upstream's Proton-only steps are skipped: no `WINEDLLOVERRIDES`
are written into launch options (ReShade, proxy-dll mods, loaders), and the
gamescope loader-console fix does nothing.

Decky lists it as **Forge**. It still installs into the plugin folder
`Nexus Mods`, because Decky keeps a plugin's settings (including the Nexus API
key), data and logs under its folder name, so updating from a build called
"Nexus Mods" keeps everything. Its updates come from the `release` branch of
[M2ljay/Eternal-Forge](https://github.com/M2ljay/Eternal-Forge) (`update.json`
and `Nexus-Mods.zip`, built by `tools/make_release.sh`).

Since anygame.67 each build also publishes `Nexus-Mods-<version>.zip` and
`update-<version>.json` (kept on the branch), and its zip carries
`forge-manifest.json`. On Windows, Decky can leave a half-copied plugin when a
file is still in use, so before handing an update to Decky Forge waits for
downloads and installs to finish and closes the helper tools it started from
its own folders (after asking). At start it checks the installed files against
the manifest, and if they don't match the panel says the last update didn't
finish copying and offers to reinstall that build.

## Upstream: Nexus Mods Decky Loader Plugin (Unofficial)

Browse, download, install, and enable/disable [Nexus Mods](https://www.nexusmods.com) content for the currently selected game, entirely from Gaming Mode with a controller, on SteamOS and Bazzite. No Desktop Mode required.

> **Built with AI, tested by hand.** Nearly all of this plugin's code was
> written by Claude, Anthropic's AI. What makes it trustworthy is not the
> author but the process around it: hundreds of hours of human direction,
> hands-on testing, and every supported game installed, modded and played on
> real hardware before it shipped. We state this plainly because you deserve
> to know how the thing you are installing was made.

> **Unofficial, and in beta.** This is a community-built plugin. It is not an
> official Nexus Mods product, is not supported by Nexus Mods, and nothing
> here is endorsed by them. It uses their public API like any other
> third-party client. Bugs are ours, so please report them here rather than
> to Nexus Mods support.

## Supported games

Twenty-five games. Every one unmarked below was installed, modded and played
on real hardware before it shipped. That is what supported means here: not
that the code has a config entry for it, but that someone finished a
session with mods running.

1. Baldur's Gate 3
2. Cyberpunk 2077
3. Elden Ring
4. Fallout 4
5. Fallout: New Vegas
6. Helldivers 2
7. Kingdom Come: Deliverance
8. Kingdom Come: Deliverance II
9. Mass Effect Legendary Edition
10. Middle-earth: Shadow of Mordor \*
11. Mount & Blade II: Bannerlord
12. NieR:Automata
13. Palworld
14. Red Dead Redemption 2
15. Resident Evil 4
16. Skyrim Special Edition
17. Slay the Spire 2
18. STAR WARS Battlefront II (2017)
19. Stardew Valley
20. Starfield \*
21. Subnautica
22. Subnautica 2
23. Subnautica: Below Zero
24. The Witcher 3
25. Valheim

\* Community added game. Not tested by author.

### On the roadmap

Groundwork exists for these and they are NOT ready. They may appear in the
plugin; treat anything you do with them as untested.

- Fallout 3
- Hollow Knight: Silksong
- Middle-earth: Shadow of War

### Requested, not started

Asked for and on the list. No code exists for these yet, so they will not
appear in the plugin until they do.

- Crimson Desert
- Dragon's Dogma 2
- Final Fantasy XII: The Zodiac Age
- Horizon Forbidden West
- Skyrim VR
- The Blood of Dawnwalker
- GTA V
- Guitar Hero World Tour

Want one moved up, or a new one added? Open a [game request][issues] and say
which. Adding a game means installing it, modding it and playing it on
hardware, so the list grows slowly and on purpose.

[issues]: https://github.com/RedRanger14/decky-nexus/issues

## What it does

- **Finds the game you are playing** and shows its Nexus mods, with search,
  sort and curated rails, on a controller.
- **Downloads and installs mods and collections** into the right place for
  that game automatically, with FOMOD installers presented as a
  controller-friendly wizard rather than a desktop dialog.
- **Applies load order automatically** where a game needs one.
- **Load Order page** for the Bethesda games: pick a plugin up with A, move it, put it down. The lower one wins.
- **Enable, disable and reset**: switch any installed mod on or off, or put
  the whole game back to vanilla.
- **A health check** that reads the game's own logs and says what is
  actually broken, rather than guessing.
- **One-tap updates**, checked against Nexus per mod.
- **Endorsements and author support links**, so the people who made the
  mods still get credit.
- **Clear feedback throughout**: live progress on long installs, and mods
  that cannot work here say so before you download them rather than
  failing after.

Not supported yet: Vortex profile import, and
mods that need a Windows tool to install.

## How to use it

The plugin shows mods for **the game you are currently looking at**, so it
needs to know which game you mean. There are two ways to tell it, and both
are things you were probably doing anyway:

- **Open the game's page in your library.** Select the game in Steam so its
  page is on screen, then open the Quick Access Menu. That is enough, the
  game does not need to be running.
- **Or launch the game.** While it is running, the plugin is scoped to it.

If you open the plugin from the Steam home screen or a menu, it has no game
to work with and will say so rather than guess.

From there:

- **Store** browses that game's mods and collections, with search and sort.
- **Downloads** shows what is in flight, and lets you pause everything.
- **My Mods** lists what is installed, and switches any of it on or off.
- **Updates** checks the installed mods against Nexus.
- **Health** reads the game's own logs and says what is actually broken,
  which is the page to open when something does not work.

Mods apply the next time the game starts. Nothing is written into the game
until you install something, and every supported game can be put back to
vanilla from the plugin.

## What you need

- **A Nexus Mods Premium account.** This is not optional. Free accounts
  cannot generate download links through the Nexus API, and the manual route
  free users take on a PC (clicking through the website, then a browser
  handoff) is not usable from Gaming Mode on a controller. With a free
  account you can browse here, but nothing will download.
- **Decky Loader**, installed on the Deck already.
- **The game installed through Steam.** Mods are applied to the Steam copy.
  Any Steam library works, including an SD card or a second drive.

## Crediting mod authors

Mods exist because people give their work away, and a plugin that makes them
invisible is a plugin that quietly costs them. So:

- **Endorsing is one button**, on the mod page in the plugin, and it is the
  same endorsement that counts on the website.
- **Author support and donation links are carried through** to the mod page
  rather than stripped out, so a mod you get hours from is one tap from the
  place its author asked to be supported.
- **Authors and versions are shown** everywhere a mod is listed, not just the
  mod name.

If something you install turns out to be good, endorse it. It costs nothing
and it is the whole economy these mods run on.

## Installing

You need [Decky Loader](https://decky.xyz) first: this is a Decky plugin, not
a standalone app.

Installing is done from Desktop Mode and takes about two minutes.

**If you have never set a password on your Deck**, do that first, because
Decky needs it and so does this. In Desktop Mode open **Konsole** and run
`passwd`. It asks for a new password twice and nothing appears as you type,
which is normal. Then install Decky, then come back here.

1. **Switch to Desktop Mode.**

   Steam button -> **Power** -> **Switch to Desktop**. The Deck reboots into
   a desktop.

2. **Open this page on the Deck**, in the browser there, and open **Konsole**
   as well.

   Konsole is in the bottom-left menu (the launcher icon): type `konsole` and
   open it. Leave both open, you will switch between them.

3. **Copy this line, paste it into Konsole, and press Enter.**

   ```sh
   curl -L https://raw.githubusercontent.com/RedRanger14/decky-nexus/main/install.sh | sh
   ```

   **To paste, right-click in Konsole -> Paste.** The easiest way to
   right-click on a Deck is the **left trigger (L2)**. Ctrl+Shift+V does not
   work from the on-screen keyboard.

   Do **not** put `sudo` in front of it. The script asks for your password
   itself, at the one step that needs it. Running the whole thing as root
   looks in the wrong home folder and fails.

4. **Type your password when it asks.**

   Nothing appears on screen as you type, which is normal. It is the same
   password you set when you installed Decky, because Decky owns its plugin
   folder as root and installing into it needs permission.

5. **It installs, then asks for your Nexus Mods API key.**

   Leave it sitting at that prompt and go and fetch the key.

   In the browser: log in to [Nexus Mods](https://www.nexusmods.com) -> your
   profile picture, top right -> **Site preferences** -> **API Keys** in the
   left-hand menu -> scroll to the very bottom -> copy the **Personal API
   Key**.

6. **Back in Konsole, paste the key at the prompt and press Enter.**

   Left trigger (L2) to right-click -> Paste, then Enter. It saves the key,
   so you never type it on a controller.

   *Rather not paste your key into a terminal? Press Enter on its own to skip.
   You can add it on the plugin's Settings page instead.*

   Steam's interface will flicker during the install, and Decky may show a
   toast saying something failed. **Ignore it.** Restarting Decky restarts
   part of Steam's UI with it, and Decky reports losing its own connection as
   a failure. The terminal is the one telling the truth.

7. **Return to Gaming Mode.**

   The **Return to Gaming Mode** icon is on the desktop.

8. **Open the plugin.**

   Quick Access Menu (the **...** button) -> the **plug** icon -> **Nexus
   Mods**.

   The panel footer shows the version and the words `unofficial beta`. If your
   game is supported and installed, it will already have found it, and your
   key is already in place.

That is Desktop Mode done with for using the plugin. Browsing, installing
mods, collections and health checks all happen from the Quick Access Menu on
the controller.

Updating is the one exception, and it is the same two minutes: see below.

### Updating

Repeat the install: Desktop Mode, Konsole, same line. It fetches the newest
release, checks it is complete before removing the old version, and restarts
Decky. Your installed mods, API key and settings live outside the plugin
folder and are not touched.

From v1.11.3 the plugin updates itself from Gaming Mode: open the Quick
Access Menu, press **Updates**, and a plugin update appears above your mod
updates. Decky asks you to confirm, then downloads it, checks it against
the published SHA-256 and installs it. No Desktop Mode, no terminal, no
password.

The older paragraph here said this was impossible because Decky's plugin
folder is owned by root. The folder is, but Decky Loader owns it and runs
as root, so the plugin does not write it: it asks Decky to, through the
same mechanism Decky's own store uses.

The Konsole line above still works and is the way to install in the first
place, or to recover if an update ever goes wrong. Nothing breaks by
staying on an older version.

### If you would rather not run a script

Download the latest `Nexus-Mods-<version>.zip` from
[Releases](https://github.com/RedRanger14/decky-nexus/releases), put it in
your **Downloads** folder, then in Gaming Mode: Quick Access Menu -> plug icon
-> **gear** -> **General** -> turn on **Developer mode** at the bottom, then
the **Developer** tab -> **Install from zip** -> Home -> Downloads -> pick the
zip.

### A note on "Install from URL"

That same Developer tab offers **Install from URL**, and it does not work with
this plugin. Decky takes the plugin's name from the URL rather than from the
zip, then stops during install with nothing written to its log, so the screen
sits on "PARSING ZIP FILE" forever. The identical zip installs correctly
through **Install from zip**, and the download and archive were both verified
byte for byte on the device, so it is neither.

Do not use it, and do not wait for it. If it starts working, this section will
say so.

### Beta

This is a **beta**. It changes game files, and while every game it supports
can be returned to vanilla from inside the plugin, back up saves you care
about first. Report anything wrong on
[GitHub Issues](https://github.com/RedRanger14/decky-nexus/issues), the
plugin can package the details for you from the Health page.

## Architecture

Standard Decky plugin layout (from the [official template](https://github.com/SteamDeckHomebrew/decky-plugin-template)):

- `src/`: React/TypeScript frontend rendered in the Quick Access Menu (`@decky/ui`, `@decky/api`).
- `main.py`: Python backend (Nexus API calls, downloads, archive extraction, folder moves).
- `plugin.json`: plugin metadata. Note: no `_root` flag; everything the plugin touches lives in the user's home directory.
- `defaults/`: files bundled alongside the built plugin in the zip.

Frontend ↔ backend communication: `callable()` for request/response, `decky.emit()` + `addEventListener` for backend-initiated events (e.g. download progress).

## Development

Prerequisites: Node.js ≥ 18, pnpm, Python 3.

```bash
pnpm i
pnpm run build   # bundles src/ into dist/index.js via rollup
```

### Deploying to hardware

**From Windows (this project's dev machine): `pnpm run deploy`**: runs [deploy.ps1](./deploy.ps1), which builds the frontend, packs the runtime files, ships them over SSH to `~/homebrew/plugins/Nexus-Mods/` on the device, and restarts `plugin_loader`. Uses Windows' built-in OpenSSH and tar; no Docker or decky CLI needed.

One-time device setup (Steam Deck, in Desktop Mode → Konsole):

1. `passwd`: set a password for the `deck` user if you never have.
2. `sudo systemctl enable --now sshd`: turn on SSH permanently.
3. Note the device's address: `steamdeck.local` usually resolves from Windows; otherwise get the IP from Settings → Internet.

One-time laptop setup:

1. Run `pnpm run deploy` once: it creates `.vscode/settings.json` (gitignored) from the defaults and exits.
2. Edit `.vscode/settings.json`: set `deckip` (hostname or IP) and `deckpass` (the password from step 1 above; used for `sudo` on the device). Leave `deckpass` as-is to be prompted each deploy instead of storing it.
3. Optional, to skip SSH password prompts: `ssh-keygen -t ed25519` then
   `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh deck@steamdeck.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`

Flags: `-SkipBuild` deploys the current `dist/` as-is; `-PackOnly` builds the tarball without touching the device.

The same script deploys to the Bazzite box, point `deckip`/`deckuser`/`deckdir` at it in `settings.json`. Both targets run Decky; Bazzite treats it as first-class, but expect occasional breakage after SteamOS updates.

Current test device: a Lenovo Legion Go 2 running SteamOS (hostname `steamdeck.local`, user `deck`, behaves identically to a Steam Deck for all plugin purposes). It suspends aggressively; the deploy script probes and retries, but wake the device before deploying. The device password must be printable ASCII (the deploy pipe scrubs non-printable bytes around it).

The template's `.vscode/` bash tasks and the [`decky` CLI](https://github.com/SteamDeckHomebrew/cli) zip pipeline remain the store-submission path later.

### Debugging on-device

- Backend log: `~/homebrew/logs/Nexus-Mods/` on the device, or `journalctl -u plugin_loader` for loader-level errors (plugin failed to load, Python exceptions at startup).
- Frontend console: enable *Allow Remote CEF Debugging* in Decky settings → Developer, then browse to `http://<device-ip>:8081` from the laptop and pick the QuickAccess/SharedJSContext target.

### Dev-loop smoke test

The current hello-world panel has a **Ping backend** button that round-trips a `callable`, displays backend environment info (user, home path, versions), and fires a backend-emitted event that surfaces as a toast, verifying all three communication channels work on real hardware.

## Build Order

1. ✅ Hello-world plugin from the template; confirm dev loop on real hardware (Deck + Bazzite box).
2. Read selected game's app ID; hardcode StS2 → Nexus game domain mapping.
3. Nexus API auth (API key via settings page) + read-only browse UI.
4. Download + extract to `mods/` (Premium flow first).
5. Enable/disable via folder moves + state tracking.
6. Modded-save warning, polish, controller UX pass.
7. Dogfood with StS2 domain expert; QA/test plan.
8. Decide free-user `nxm://` story and second game candidate.

## License

BSD-3-Clause (inherited from the Decky plugin template, see [LICENSE](./LICENSE)).

## Fork: experimental "any game" support

This fork adds an opt-in **Experimental: any game** switch (Settings, or the
Current Game section of an unsupported game). With it on, an unsupported Steam
game gets a **Set up mods for …** button that:

1. matches the game to its Nexus Mods domain by name (a picker appears when
   the match is not exact), so browsing, downloading and endorsing work, and
2. looks at the installed files to guess where drop-in mods go - Unreal
   `Content/Paks/~mods` (plus UE4SS when present), `BepInEx/plugins`,
   MelonLoader `Mods`, or an existing `Mods` folder - and installs through the
   normal folder-mode installer, so enable/disable and uninstall work.

Curated games are unaffected. The helpers are in
`py_modules/experimental_games.py`. The fork also finds Steam on Windows
(registry), extracts archives with Windows' built-in `tar.exe` or 7-Zip, and
registers the `nxm://` handler in the Windows registry.

### GameBanana as a second source

Many games' mods live on GameBanana rather than Nexus. **Store → GameBanana**
browses, searches and sorts the current game's GameBanana mods, opens a mod's
page (description, pictures, files) and installs a file through the same
pipeline as Nexus mods: same install modes, FOMOD and folder choices,
Downloads, restore points, enable/disable and uninstall. They show in My Mods
tagged GameBanana, and on Updates when a newer upload of the installed file
appears. The Steam game is linked to its GameBanana game by name, or picked
by hand once and remembered. No account or key is needed. Details, endpoints
and what is still unverified: [docs/gamebanana.md](docs/gamebanana.md).

## Fork: Forge on the game page

Details, sources and the reasoning: [docs/forge.md](docs/forge.md).

- **Mods section on Steam's game page.** One compact row under the Play bar
  on a game's library page (never over the hero): "Mods", a status chip
  (*Locked · Ricochet*, *3 enabled*, *Updates 2*, *Not modded*), the last
  save backup, and up to two buttons (**Mods...**, **Restore saves...**). A
  opens one-line details: the mods with a switch each, Open / Update, Add
  mods, My Mods, saves, Upscaling and Load order; long explanations are
  behind **Why?**. Where Play's section cannot be found it falls back to a
  single line above Play. Controller only; B from a page opened here
  returns to the game page. Any error leaves Steam's page untouched, and the
  section switches itself off for the session after three.
- **Anti-cheat lock.** Games with a client-side anti-cheat (Easy Anti-Cheat,
  BattlEye, Vanguard, Ricochet, FACEIT, EA Javelin, GameGuard...) are locked:
  installs and switching mods on are refused by the backend, not just hidden.
  Switching off always works. Sources: a 500-game list generated from
  AreWeAntiCheatYet (MIT) and the anti-cheat file markers Core's Gaming Mode
  uses. Every locked game has a one-press "Allow mods anyway" in the QAM
  and, on the game page, inside the lock's **Why?** modal, labelled with its risk ("play modded offline only"
  for games with an offline mode, "may get this account banned" for the
  rest), and "Lock mods again". Elden Ring and Helldivers 2 start locked.
- **Way back after a crash.** A run of at least 60 seconds with no Windows
  crash report makes its mods the last known good set. Two shorter (or
  crashed) runs in a row after a mod change bring one notification and an
  offer on the game page to restore that set - by switching mods only,
  never deleting, with Undo.
- **Update dots.** A crimson dot on library and home tiles of games with mod
  updates, from a six-hour cache of Nexus versions (three games per check at
  most, also filled by the Updates page). Pure CSS that matches nothing if
  Steam changes its markup.
- **Modded collection.** A Steam collection "Modded" with every game that
  has at least one mod on, updated when mods are switched, installed or
  removed (crash restore and anti-cheat lock included) and at load. Offline,
  no Nexus calls. Forge only ever touches the collection it created: a
  "Modded" of your own is left alone (Forge's is then "Modded (Forge)"), and
  games you added by hand are never taken out.

- **Save backups before mod changes (optional).** With
  [Ludusavi](https://github.com/mtkennerly/ludusavi) installed
  (`winget install -e --id mtkennerly.ludusavi`; Forge never installs it),
  a game's saves are backed up into Ludusavi's own backup folder before
  Forge installs or switches on its mods, and before a crash restore or
  Undo. At most once per game in 30 minutes (configurable), time-boxed to
  60 seconds, and a failed backup never stops the mod change (a small note
  says so). The game page shows the last backup and **Restore saves...**,
  which restores only after a confirmation and a fresh backup of the
  current saves. Without Ludusavi, Settings shows one line and nothing else
  changes.
- **Upscaling (OptiScaler).** A line in the game page's Mods section that
  installs [OptiScaler](https://github.com/optiscaler/OptiScaler) (GPL-3.0)
  for that one game: FSR 4 on an RDNA 4 Radeon, otherwise FSR 3.1, XeSS, or
  DLSS passed through on NVIDIA. It is downloaded from OptiScaler's official
  GitHub release when you install (never shipped with Forge), checked
  against GitHub's SHA-256 digest, and put next to the game's exe as
  `dxgi.dll` (or `winmm.dll` / `version.dll`); any file it replaces is set
  aside and put back on removal. No launch options. Saves are backed up
  first (Ludusavi), and if the game crashes or closes within a minute on
  the next runs, the game page offers one-press removal. **Refused, with no
  override**, for every anti-cheat game (including ones you allowed mods
  for) and for online-competitive games: *Not allowed: anti-cheat (DLL
  injection)*.

- **Load order with LOOT rules, and profiles.** For Skyrim SE, Fallout 4,
  Starfield and Oblivion Remastered: a Load order line on the game page
  (problems in crimson, warnings in amber) and a panel to move plugins
  with the D-pad, pin one in place, and **Sort with LOOT rules**: masters
  and plugin flags from the plugin headers, plus the `after` / `req` /
  group rules of [LOOT's masterlist](https://github.com/loot) (CC0,
  downloaded at most daily, the saved copy used offline; never shipped).
  Pure Python, no LOOT program. Warns about missing masters,
  incompatibilities and dirty plugins. **Profiles** ("Vanilla+", "Full
  modlist"...) hold which mods are on and the load order; switching one
  backs up saves with Ludusavi, switches mods through Forge's usual
  install path and rewrites `Plugins.txt` (and Oblivion Remastered's
  `loadorder.txt`), and is refused while the game runs.

These can be turned off in Settings, under **Game page**. Turning off the
Modded collection leaves it as it is; **Remove Modded collection** deletes
only Forge's own.
