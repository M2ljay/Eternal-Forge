// "Recommended mods": a starter pack for a game - the most-endorsed mods in
// its fix, patch and utility categories that aren't installed yet, and its
// most-endorsed collection - installable from one place.
import { ButtonItem, Field, ModalRoot, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import {
  CollectionSummary,
  NexusMod,
  getCollections,
  getGameCategories,
  getInstalledMods,
  getMods,
} from "./api";
import { SupportedGame, modeParams } from "./games";
import { installLatest } from "./install";
import { setDetailOrigin, setSelectedCollection } from "./state";
import { pushOurPage } from "./Tabs";

const ESSENTIAL = /fix|patch|unofficial|utilit|framework|performance|engine|loader|stabil/i;

async function loadPack(game: SupportedGame) {
  const [mode, appId, sub, style] = modeParams(game);
  const [cats, installed, cols] = await Promise.all([
    getGameCategories(game.nexusDomain).catch(() => undefined),
    getInstalledMods(game.nexusDomain, game.installDirName, game.modsSubdir, mode as any, appId as number,
      (sub as string) ?? "", (style as any) ?? "starred", []).catch(() => undefined),
    getCollections(game.nexusDomain, 2, "", "endorsements", 0).catch(() => undefined),
  ]);
  const have = new Set((installed?.mods ?? []).map((m) => m.mod_id).filter(Boolean));
  const picked = (cats?.categories ?? []).filter((c) => ESSENTIAL.test(c)).slice(0, 4);
  const lists = await Promise.all(
    (picked.length ? picked : [""]).map((c) =>
      getMods(game.nexusDomain, "endorsements", picked.length ? 4 : 6, 0, "", game.appId, c).catch(() => undefined)
    )
  );
  const seen = new Set<number>();
  const mods: (NexusMod & { category: string })[] = [];
  lists.forEach((r, i) => {
    for (const m of (r as any)?.mods ?? []) {
      if (have.has(m.modId) || seen.has(m.modId) || m.adultContent) continue;
      seen.add(m.modId);
      mods.push({ ...m, category: picked[i] ?? "Most endorsed" });
    }
  });
  return { mods: mods.slice(0, 10), collection: cols?.collections?.[0], installedCount: have.size };
}

function RecommendedModal({ game, onChanged, closeModal }: {
  game: SupportedGame;
  onChanged: () => void;
  closeModal?: () => void;
}) {
  const [pack, setPack] = useState<Awaited<ReturnType<typeof loadPack>> | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => void loadPack(game).then(setPack), []);
  const install = async (list: NexusMod[]) => {
    let ok = 0;
    const failed: string[] = [];
    for (const m of list) {
      setBusy(String(m.modId));
      const r = await installLatest(game, m.modId, m.name, "", "").catch((e) => ({ ok: false, error: String(e) }));
      if (r.ok) ok++;
      else failed.push(m.name);
    }
    setBusy("");
    onChanged();
    setPack((p) => (p ? { ...p, mods: p.mods.filter((m) => !list.includes(m) || failed.includes(m.name)) } : p));
    toaster.toast({
      title: `Installed ${ok} of ${list.length}`,
      body: failed.length ? `Open these on their pages to pick a file: ${failed.join(", ")}` : "Restart the game to load them",
    });
  };
  const openCollection = (c: CollectionSummary) => {
    closeModal?.();
    setSelectedCollection({ game, collection: c });
    setDetailOrigin("browse");
    pushOurPage("/nexus-mods/collection");
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`Recommended mods - ${game.displayName}`} bottomSeparator="none">
        The most-endorsed fixes, patches and utilities for this game that you don't have yet, and its
        most popular collection. Check a mod's page first if you're unsure: popular isn't always right
        for every setup.
      </Field>
      {!pack && <Field label="Looking on Nexus…" />}
      {pack?.collection && (
        <ButtonItem
          layout="below"
          label={`Collection: ${pack.collection.name}`}
          description={`${pack.collection.modCount} mods · ${pack.collection.endorsements} endorsements · by ${pack.collection.author}`}
          onClick={() => openCollection(pack.collection!)}
        >
          Open collection
        </ButtonItem>
      )}
      {pack && pack.mods.length > 1 && (
        <ButtonItem layout="below" disabled={!!busy} onClick={() => void install(pack.mods)}>
          {busy ? "Installing…" : `Install all ${pack.mods.length} below`}
        </ButtonItem>
      )}
      {pack?.mods.length === 0 && <Field label="You already have the most-endorsed essentials." />}
      {pack?.mods.map((m) => (
        <ButtonItem
          key={m.modId}
          layout="below"
          disabled={!!busy}
          label={m.name}
          description={`${m.category} · ${m.endorsements} endorsements${m.summary ? ` · ${m.summary.slice(0, 90)}` : ""}`}
          onClick={() => void install([m])}
        >
          {busy === String(m.modId) ? "Installing…" : "Install"}
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

export function openRecommended(game: SupportedGame, onChanged: () => void) {
  showModal(<RecommendedModal game={game} onChanged={onChanged} />);
}
