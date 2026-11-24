// Tools that work for every game: saved mod setups, which mods overwrite
// which files, what the plugin keeps on disk, saving a game's setup to a
// file and back, and a problem report to send.
import {
  ButtonItem,
  ConfirmModal,
  Field,
  ModalRoot,
  PanelSectionRow,
  TextField,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import {
  ModOverlap,
  SetupBackupMod,
  SpaceItem,
  applyModSetup,
  RestorePoint,
  clearSpaceItem,
  createRestorePoint,
  deleteModSetup,
  getRestorePlan,
  listRestorePoints,
  restorePointSaves,
  exportModSetup,
  getModFiles,
  getModOverlaps,
  getModSetups,
  getSpaceReport,
  listSetupBackups,
  readSetupBackup,
  saveModSetup,
  saveProblemReport,
} from "./api";
import { SupportedGame, isExperimentalGame, modeParams } from "./games";
import { installLatest, installModWith, removeMod, toggleMod } from "./install";
import { VrSetupRows } from "./VrSetup";
import { openRecommended } from "./Recommended";

function gb(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`;
  return n > 0 ? `${Math.max(1, Math.round(n / 1024))} KB` : "empty";
}

function modArgs(game: SupportedGame) {
  const [mode, appId, sub, style] = modeParams(game);
  return [game.installDirName, game.modsSubdir, mode, game.nexusDomain, appId, sub, style] as const;
}

function SetupsModal({
  game,
  onChanged,
  closeModal,
}: {
  game: SupportedGame;
  onChanged: () => void;
  closeModal?: () => void;
}) {
  const [setups, setSetups] = useState<{ name: string; count: number }[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => void getModSetups(game.nexusDomain).then((r) => setSetups(r.setups ?? []));
  useEffect(load, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      load();
      onChanged();
    }
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`Mod setups - ${game.displayName}`} bottomSeparator="none">
        A setup remembers which installed mods are switched on. Applying one switches mods on
        and off to match; nothing is uninstalled.
      </Field>
      <TextField label="Name for the current mods" value={name} onChange={(e) => setName(e.target.value)} />
      <ButtonItem
        layout="below"
        disabled={busy || !name.trim()}
        onClick={() =>
          run(async () => {
            const r = await saveModSetup(...modArgs(game), name);
            toaster.toast({
              title: r.ok ? `Saved "${name.trim()}"` : "Couldn't save it",
              body: r.ok ? `${r.count} mods switched on` : r.error ?? "",
            });
            if (r.ok) setName("");
          })
        }
      >
        Save current mods as a setup
      </ButtonItem>
      {setups === null && <Field label="Loading…" />}
      {setups?.length === 0 && <Field label="No setups saved yet" />}
      {setups?.map((s) => (
        <Field key={s.name} label={s.name} description={`${s.count} mods on`} childrenLayout="below">
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await applyModSetup(...modArgs(game), s.name);
                const extra = [
                  ...(r.errors ?? []),
                  ...((r.missing?.length ?? 0) > 0 ? [`${r.missing!.length} of its mods aren't installed now`] : []),
                ];
                toaster.toast({
                  title: r.ok ? `Switched to "${s.name}"` : "Couldn't switch",
                  body: r.ok ? (extra.length ? extra.join("; ") : `${r.moved} mods changed`) : r.error ?? "",
                });
              })
            }
          >
            Apply
          </ButtonItem>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={() => run(async () => void (await deleteModSetup(game.nexusDomain, s.name)))}
          >
            Delete
          </ButtonItem>
        </Field>
      ))}
    </ModalRoot>
  );
}

function OverlapsModal({ game, closeModal }: { game: SupportedGame; closeModal?: () => void }) {
  const [data, setData] = useState<{
    overlaps: ModOverlap[];
    replaces: { name: string; files: number; on: boolean }[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    void getModOverlaps(game.nexusDomain).then((r) =>
      setData({ overlaps: r.overlaps ?? [], replaces: r.replaces ?? [], error: r.ok ? undefined : r.error })
    );
  }, []);
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`File overlaps - ${game.displayName}`} bottomSeparator="none">
        Mods that change the same files. In the game folder only one copy can be there: the one
        shown as in use. Inside the mods folder both stay, and the game decides which it reads.
      </Field>
      {!data && <Field label="Looking…" />}
      {data?.error && <Field label={data.error} />}
      {data && !data.error && data.overlaps.length === 0 && <Field label="No two mods change the same files." />}
      {data?.overlaps.map((o, i) => (
        <Field
          key={i}
          label={o.mods.join(" + ")}
          description={
            `${o.files} file${o.files === 1 ? "" : "s"}, e.g. ${o.examples.join(", ")}. ` +
            (o.kind === "game"
              ? o.active
                ? `In use: ${o.active}.`
                : "None of them is on."
              : "Both in the mods folder - the game picks (often by name order).")
          }
        />
      ))}
      {(data?.replaces.length ?? 0) > 0 && (
        <Field label="Replacing the game's own files" bottomSeparator="none">
          {data!.replaces
            .map((r) => `${r.name}: ${r.files} file${r.files === 1 ? "" : "s"}${r.on ? "" : " (off - originals back)"}`)
            .join(" · ")}
        </Field>
      )}
    </ModalRoot>
  );
}

function StorageModal({ game, closeModal }: { game?: SupportedGame; closeModal?: () => void }) {
  const [items, setItems] = useState<SpaceItem[] | null>(null);
  const [free, setFree] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const load = () =>
    void getSpaceReport(game?.nexusDomain ?? "").then((r) => {
      setItems(r.items ?? []);
      setFree(r.game_free ?? null);
    });
  useEffect(load, []);
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label="What the plugin keeps on disk" bottomSeparator="none">
        {free !== null ? `${gb(free)} free on ${game?.displayName}'s drive. ` : ""}
        Clearing deletes those files for good.
      </Field>
      {!items && <Field label="Measuring…" />}
      {items?.map((it) => (
        <Field key={it.id} label={`${it.label}: ${gb(it.bytes)}`} description={it.note} childrenLayout="below">
          {it.clearable && it.bytes > 0 && (
            <ButtonItem
              layout="below"
              disabled={!!busy}
              onClick={() =>
                showModal(
                  <ConfirmModal
                    strTitle={`Clear ${it.label.toLowerCase()}?`}
                    strDescription={`${gb(it.bytes)} will be deleted permanently. ${it.note}`}
                    strOKButtonText="Delete"
                    onOK={async () => {
                      setBusy(it.id);
                      try {
                        const r = await clearSpaceItem(game?.nexusDomain ?? "", it.id);
                        toaster.toast({
                          title: r.ok ? `Freed ${gb(r.freed ?? 0)}` : "Couldn't clear it",
                          body: r.error ?? "",
                        });
                      } finally {
                        setBusy("");
                        load();
                      }
                    }}
                  />
                )
              }
            >
              {busy === it.id ? "Clearing…" : "Clear"}
            </ButtonItem>
          )}
        </Field>
      ))}
    </ModalRoot>
  );
}

async function restoreMods(game: SupportedGame, mods: SetupBackupMod[], onDone: () => void) {
  const todo = mods.filter((m) => !m.installed);
  let done = 0;
  const failed: string[] = [];
  for (const m of todo) {
    let r;
    try {
      const files = m.file_id ? await getModFiles(game.nexusDomain, m.mod_id) : undefined;
      const file = files?.files?.find((f) => f.file_id === m.file_id);
      r = file
        ? await installModWith(game, m.mod_id, file.file_id, file.file_name, m.name, file.version || m.version || "", "", "", "", m.choice ?? "")
        : await installLatest(game, m.mod_id, m.name, "", m.choice ?? "");
    } catch (e) {
      r = { ok: false, error: String(e) };
    }
    if (r.ok) done++;
    else failed.push(m.name + ((r as { needs_choice?: boolean }).needs_choice ? " (pick a version on its page)" : ""));
  }
  // Mods the backup had switched off go back off.
  for (const m of mods.filter((x) => !x.enabled)) {
    await toggleMod(game, m.key, false).catch(() => undefined);
  }
  onDone();
  toaster.toast({
    title: `Restored ${done} of ${todo.length} mods`,
    body: failed.length ? `Not installed: ${failed.join(", ")}` : "Everything in the backup is installed",
  });
}

function RestoreModal({
  game,
  onChanged,
  closeModal,
}: {
  game: SupportedGame;
  onChanged: () => void;
  closeModal?: () => void;
}) {
  const [backups, setBackups] = useState<{ file: string; at: number; count: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void listSetupBackups(game.nexusDomain).then((r) => setBackups(r.backups ?? [])), []);
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`Restore mods - ${game.displayName}`} bottomSeparator="none">
        Setup files saved in your Downloads folder. Restoring installs every mod in it that isn't
        installed now (set the game up and run Step 1 first). Saved setups come back too.
      </Field>
      {backups === null && <Field label="Looking in Downloads…" />}
      {backups?.length === 0 && <Field label="No setup files for this game in Downloads" />}
      {backups?.map((b) => (
        <ButtonItem
          key={b.file}
          layout="below"
          disabled={busy}
          description={`${b.count} mods`}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await readSetupBackup(game.nexusDomain, b.file);
              if (!r.ok || !r.mods) {
                toaster.toast({ title: "Couldn't read it", body: r.error ?? "" });
                return;
              }
              const missing = r.mods.filter((m) => !m.installed).length;
              toaster.toast({ title: `Installing ${missing} mods`, body: "The Downloads page shows each one" });
              closeModal?.();
              await restoreMods(game, r.mods, onChanged);
            } finally {
              setBusy(false);
            }
          }}
        >
          {b.file.replace(/^Nexus Mods setup - [^-]+ - /, "").replace(/\.json$/, "")}
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

function pointTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function restorePoint(game: SupportedGame, p: RestorePoint, withSaves: boolean, onDone: () => void) {
  const plan = await getRestorePlan(game.nexusDomain, p.id);
  if (!plan.ok) {
    toaster.toast({ title: "Couldn't restore", body: plan.error ?? "" });
    return;
  }
  // The present first, so this restore can be undone too.
  await createRestorePoint(game.nexusDomain, game.appId, "Before restoring an earlier point");
  const failed: string[] = [];
  for (const m of plan.remove) {
    const r = await removeMod(game, m.key).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) failed.push(`remove ${m.name}`);
  }
  for (const key of plan.enable) await toggleMod(game, key, true).catch(() => undefined);
  for (const key of plan.disable) await toggleMod(game, key, false).catch(() => undefined);
  let savesNote = "";
  if (withSaves && plan.saves) {
    const r = await restorePointSaves(game.nexusDomain, p.id);
    savesNote = r.ok ? `, saves put back (${r.files} files)` : `, saves not restored: ${r.error}`;
  }
  if (plan.install.length) {
    toaster.toast({ title: `Reinstalling ${plan.install.length} mods`, body: "The Downloads page shows each one" });
    await restoreMods(game, plan.install, onDone);
  } else {
    onDone();
  }
  toaster.toast({
    title: failed.length ? "Restored, with problems" : `Back to ${pointTime(p.at)}`,
    body:
      `${plan.remove.length} removed, ${plan.install.length} reinstalled, ` +
      `${plan.enable.length + plan.disable.length} switched${savesNote}` +
      (failed.length ? `. Failed: ${failed.join(", ")}` : ""),
  });
}

function RestorePointsModal({
  game,
  onChanged,
  closeModal,
}: {
  game: SupportedGame;
  onChanged: () => void;
  closeModal?: () => void;
}) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => void listRestorePoints(game.nexusDomain).then((r) => setPoints(r.points ?? []));
  useEffect(load, []);
  const ask = (p: RestorePoint) =>
    showModal(
      <ConfirmModal
        strTitle={`Go back to ${pointTime(p.at)}?`}
        strDescription={
          `Mods go back to how they were then: ${p.count} installed, ${p.on} on. Mods added since are ` +
          "removed and removed ones reinstalled (the same files, if Nexus still has them). " +
          (p.saves ? "Choose whether your saves go back too. " : "") +
          "A restore point of right now is made first."
        }
        strOKButtonText={p.saves ? "Mods and saves" : "Restore mods"}
        strMiddleButtonText={p.saves ? "Mods only" : undefined}
        onMiddleButton={p.saves ? () => void run(p, false) : undefined}
        onOK={() => void run(p, p.saves)}
      />
    );
  const run = async (p: RestorePoint, saves: boolean) => {
    setBusy(true);
    closeModal?.();
    try {
      await restorePoint(game, p, saves, onChanged);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`Restore points - ${game.displayName}`} bottomSeparator="none">
        Made by themselves before mods are installed, updated or removed (at most every 10
        minutes), with the game's Steam Cloud saves when it has them. The last 12 are kept.
      </Field>
      <ButtonItem
        layout="below"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await createRestorePoint(game.nexusDomain, game.appId, "Made by you");
            toaster.toast({
              title: r.ok ? "Restore point made" : "Couldn't make one",
              body: r.ok ? `${r.count} mods${r.saves ? `, ${r.saves} save files` : ""}` : r.error ?? "",
            });
          } finally {
            setBusy(false);
            load();
          }
        }}
      >
        Make a restore point now
      </ButtonItem>
      {points === null && <Field label="Loading…" />}
      {points?.length === 0 && <Field label="No restore points yet" />}
      {points?.map((p) => (
        <ButtonItem
          key={p.id}
          layout="below"
          disabled={busy}
          label={pointTime(p.at)}
          description={`${p.reason} · ${p.count} mods, ${p.on} on${p.saves ? " · saves" : ""}`}
          onClick={() => ask(p)}
        >
          Go back to this
        </ButtonItem>
      ))}
    </ModalRoot>
  );
}

function ReportModal({ game, closeModal }: { game?: SupportedGame; closeModal?: () => void }) {
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label="Save a problem report" bottomSeparator="none">
        Puts the plugin's recent logs and {game ? `${game.displayName}'s mod list` : "settings"} in one
        text file in your Downloads folder, with your Nexus API key and other secrets taken out.
        Nothing is sent anywhere.
      </Field>
      <TextField label="What went wrong (optional)" value={what} onChange={(e) => setWhat(e.target.value)} />
      <ButtonItem
        layout="below"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await saveProblemReport(game?.nexusDomain ?? "", game?.appId ?? 0, what);
            toaster.toast({
              title: r.ok ? "Problem report saved" : "Couldn't save it",
              body: r.ok ? (r.path ?? "").split(/[\\/]/).pop() ?? "" : r.error ?? "",
            });
            if (r.ok) closeModal?.();
          } finally {
            setBusy(false);
          }
        }}
      >
        Save report
      </ButtonItem>
    </ModalRoot>
  );
}

/** Rows for the Installed Mods section of the current game. */
export function ModToolsRows({ game, onChanged }: { game: SupportedGame; onChanged: () => void }) {
  const exp = isExperimentalGame(game);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="A starter pack: the most-endorsed fixes and utilities you don't have yet, and the top collection"
          onClick={() => openRecommended(game, onChanged)}
        >
          Recommended mods…
        </ButtonItem>
      </PanelSectionRow>
      <VrSetupRows game={game} />
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="Save which mods are on under a name, and switch between setups"
          onClick={() => showModal(<SetupsModal game={game} onChanged={onChanged} />)}
        >
          Mod setups…
        </ButtonItem>
      </PanelSectionRow>
      {exp && (
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            description="Which mods change the same files, and which one is in use"
            onClick={() => showModal(<OverlapsModal game={game} />)}
          >
            File overlaps…
          </ButtonItem>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="Go back to how this game's mods (and saves) were before a change"
          onClick={() => showModal(<RestorePointsModal game={game} onChanged={onChanged} />)}
        >
          Restore points…
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy}
          description="A file in Downloads listing every mod here, to reinstall them after a reinstall or on another PC"
          onClick={async () => {
            setBusy(true);
            try {
              const r = await exportModSetup(game.nexusDomain);
              toaster.toast({
                title: r.ok ? `Saved ${r.count} mods` : "Couldn't save",
                body: r.ok ? (r.path ?? "").split(/[\\/]/).pop() ?? "" : r.error ?? "",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          Save mod list to a file
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => showModal(<RestoreModal game={game} onChanged={onChanged} />)}>
          Restore mods from a file…
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          description="Backups and kept files the plugin stores, and what's free on the game's drive"
          onClick={() => showModal(<StorageModal game={game} />)}
        >
          Storage…
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => showModal(<ReportModal game={game} />)}>
          Save a problem report…
        </ButtonItem>
      </PanelSectionRow>
    </>
  );
}
