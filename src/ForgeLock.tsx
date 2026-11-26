// The anti-cheat lock's one-press bypass, shared by the game page's Mods
// section and the QAM. No confirmation dialog: the button's own label says
// what the risk is, and the backend still checks the stored flag on every
// install and switch.
import { ButtonItem, Field, PanelSection, PanelSectionRow, useQuickAccessVisible } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import { forgeGameStatus, forgeSetAnticheatOverride } from "./api";
import { AntiCheatVerdict, lockBody, lockHeadline, overrideLabel } from "./forgeRules";
import type { SupportedGame } from "./games";
import { notifyGameStateChanged } from "./state";

export async function allowModsAnyway(appId: number): Promise<boolean> {
  const r = await forgeSetAnticheatOverride(appId, true, "");
  if (!r.ok) toaster.toast({ title: "Still locked", body: r.error ?? "" });
  return r.ok;
}

export async function lockModsAgain(appId: number): Promise<boolean> {
  const r = await forgeSetAnticheatOverride(appId, false, "");
  return r.ok;
}

export function overrideOnLabel(v: AntiCheatVerdict): string {
  return v.risk === "offline"
    ? "Anti-cheat lock off - play modded offline only"
    : "Anti-cheat lock off - this account may be banned";
}

// ---- QAM rows -----------------------------------------------------------------
// The QAM's own install buttons stay where they are (the backend refuses
// them while the game is locked); this section, at the top of the game's
// sections, says so and offers the same one-press bypass.

export function ForgeLockSection({ game }: { game: SupportedGame }) {
  const [v, setV] = useState<AntiCheatVerdict | undefined>();
  const [busy, setBusy] = useState(false);
  const visible = useQuickAccessVisible();
  const load = () =>
    void forgeGameStatus(game.appId, game.nexusDomain, game.installDirName)
      .then((r) => setV(r.ok ? r.anticheat : undefined))
      .catch(() => setV(undefined));
  useEffect(load, [game.appId]);
  useEffect(() => {
    if (visible) load();
  }, [visible]);
  if (!v?.detected) return null;
  const press = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      load();
      notifyGameStateChanged();
    }
  };
  if (!v.locked) {
    return (
      <PanelSection title="Anti-cheat">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            description={overrideOnLabel(v)}
            onClick={() => void press(() => lockModsAgain(game.appId))}
          >
            Lock mods again
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    );
  }
  return (
    <PanelSection title={lockHeadline(v)}>
      <PanelSectionRow>
        <Field description={lockBody(v)} bottomSeparator="none" />
      </PanelSectionRow>
      {v.override_allowed && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={() => void press(() => allowModsAnyway(game.appId))}
          >
            {overrideLabel(v)}
          </ButtonItem>
        </PanelSectionRow>
      )}
    </PanelSection>
  );
}
