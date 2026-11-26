"""Build py_modules/anticheat_games.json from AreWeAntiCheatYet's games.json.

    python tools/make_anticheat_list.py path/to/games.json

Source: https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet (games.json,
MIT licence, (c) 2021 Starz0r, Curve). Only games with a Steam app id and at
least one client-side anti-cheat (kernel driver or in-process module) are
kept. Server-side or retired systems are left out on purpose: VAC and
PunkBuster games include Left 4 Dead 2 and Garry's Mod, whose mods are the
point of the game, and FairFight runs on the server only (Battlefront II,
one of the plugin's supported games, has nothing else).
"""
import datetime
import hashlib
import json
import os
import sys

# Anti-cheats that run on the player's PC and can see a modded game.
CLIENT_SIDE = {
    "Easy Anti-Cheat", "BattlEye", "nProtect GameGuard", "XIGNCODE3",
    "Anti-Cheat Expert", "Nexon Game Security", "X-Trap", "EA anticheat",
    "AhnLab HackShield", "Denuvo Anti-Cheat", "NEAC Protect", "RICOCHET",
    "Ricochet", "Mail.ru Anti-Cheat", "MY.GAMES Anti-Cheat", "EQU8", "FACEIT",
    "NetEase Anti-Cheat Expert", "NetEase Game Security", "NetEase Yidun",
    "TenProtect", "Hyperion", "Zakynthos", "R6 ShieldGuard", "Seasun Protect",
    "Vanguard", "miHoYo Protect", "WFSDrv", "Proxima Game Anti Cheat",
}
# Same product, two spellings in the source.
CANONICAL = {"RICOCHET": "Ricochet"}


def build(games: list) -> dict:
    out = {}
    for g in games:
        steam = str((g.get("storeIds") or {}).get("steam") or "").strip()
        if not steam.isdigit():
            continue
        acs = [CANONICAL.get(a, a) for a in g.get("anticheats") or [] if a in CLIENT_SIDE]
        if not acs:
            continue
        entry = out.setdefault(steam, {"name": g.get("name") or "", "anticheats": []})
        for a in acs:
            if a not in entry["anticheats"]:
                entry["anticheats"].append(a)
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))


def main(path: str) -> int:
    with open(path, "rb") as f:
        raw = f.read()
    games = build(json.loads(raw))
    doc = {
        "source": "https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet (games.json)",
        "license": "MIT, Copyright (c) 2021 Starz0r, Curve",
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "generated": datetime.date.today().isoformat(),
        "kept": sorted(CLIENT_SIDE),
        "games": games,
    }
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "py_modules",
                          "anticheat_games.json")
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=0, ensure_ascii=False)
        f.write("\n")
    print(f"{len(games)} games written to {os.path.normpath(target)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
