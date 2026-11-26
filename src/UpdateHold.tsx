// Updates page: the hold on Steam updates for modded games, and which of
// those games has an update waiting to install at its next launch.
import { Focusable } from "@decky/ui";
import { useEffect, useState } from "react";

import { getUpdateHold, getWaitingUpdates, setUpdateHoldEnabled } from "./api";
import { managedGames } from "./games";
import { AccentToggle } from "./Toggle";
import { applyUpdateHold } from "./holdUpdates";
import { alpha, AMBER } from "./palette";

export function UpdateHoldSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [held, setHeld] = useState<string[]>([]);
  const [waiting, setWaiting] = useState<string[]>([]);
  const load = async () => {
    const st = await getUpdateHold().catch(() => undefined);
    if (!st?.ok) return;
    setEnabled(st.enabled);
    const games = managedGames().filter((g) => String(g.appId) in st.held);
    setHeld(games.map((g) => g.displayName));
    const w = await getWaitingUpdates(games.map((g) => g.appId)).catch(() => undefined);
    setWaiting(games.filter((g) => w?.waiting?.includes(g.appId)).map((g) => g.displayName));
  };
  useEffect(() => void load(), []);
  if (enabled === null) return null;
  return (
    <Focusable style={{ margin: "18px 0 8px", maxWidth: "640px" }}>
      <Focusable style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ flexGrow: 1 }}>
          <div style={{ fontWeight: 600 }}>Hold game updates for modded games</div>
          <div style={{ fontSize: "12.5px", opacity: 0.65 }}>
            Games with mods update only when you launch them, never overnight, so an update can't
            break your mods unseen.
            {held.length ? ` Held now: ${held.length} game${held.length === 1 ? "" : "s"}.` : ""}
          </div>
        </div>
        <AccentToggle
          checked={enabled}
          onChange={async (next) => {
            setEnabled(next);
            await setUpdateHoldEnabled(next);
            await applyUpdateHold().catch(() => undefined);
            void load();
          }}
        />
      </Focusable>
      {waiting.length > 0 && (
        <div
          style={{
            marginTop: "8px",
            padding: "8px 12px",
            borderRadius: "4px",
            background: alpha(AMBER, 0.12),
            fontSize: "12.5px",
          }}
        >
          Game update waiting for {waiting.join(", ")}. It installs when you next launch the game;
          check this page afterwards for mod updates that match it.
        </div>
      )}
    </Focusable>
  );
}
