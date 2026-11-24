// VR setups made by outside tools (MRSURVIV0R's VR HUB, UEVR, a mod's own
// installer). The plugin can't read what those tools did, so it records
// the game folder before and after the tool runs, and from then on keeps
// every file the tool added or changed: uninstalls, switching mods off,
// framework removal and vanilla restores leave them in place.
import { ButtonItem, ConfirmModal, Field, ModalRoot, PanelSectionRow, showModal } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import {
  VrSetupState,
  cancelVrRecording,
  finishVrRecording,
  forgetVrSetup,
  getVrFiles,
  getVrSetup,
  openVrHub,
  startVrRecording,
} from "./api";
import { SupportedGame } from "./games";

const HUB = "MRSURVIV0R's VR HUB";

function when(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function start(game: SupportedGame, openHub: boolean, onDone: () => void) {
  const r = await startVrRecording(game.nexusDomain, game.installDirName, game.modsSubdir ?? "");
  if (!r.ok) {
    toaster.toast({ title: "Couldn't start recording", body: r.error ?? "" });
    return;
  }
  if (openHub) {
    const h = await openVrHub("");
    if (!h.ok) toaster.toast({ title: `Couldn't open ${HUB}`, body: h.error ?? "" });
  }
  toaster.toast({
    title: `Recording ${game.displayName}'s VR setup`,
    body: "Set it up in the VR tool, then come back and press Finish VR recording",
  });
  onDone();
}

function StartModal({
  game,
  hub,
  onDone,
  closeModal,
}: {
  game: SupportedGame;
  hub: string;
  onDone: () => void;
  closeModal?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const go = (openHub: boolean) => async () => {
    setBusy(true);
    try {
      await start(game, openHub, onDone);
      closeModal?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`Record a VR setup - ${game.displayName}`} bottomSeparator="none">
        For VR mods set up by {HUB} or another VR tool. The plugin lists the game's files now, you
        run the VR tool, then press Finish VR recording: whatever the tool added or changed is kept
        from then on. Uninstalling mods, switching them off and restoring the game won't remove it.
        Don't install Nexus mods for this game until you finish.
      </Field>
      {hub && (
        <ButtonItem layout="below" disabled={busy} onClick={go(true)} description={hub.split(/[\\/]/).pop()}>
          Start recording and open {HUB}
        </ButtonItem>
      )}
      <ButtonItem layout="below" disabled={busy} onClick={go(false)}>
        {hub ? "Start recording only" : "Start recording"}
      </ButtonItem>
      {!hub && (
        <Field label={`${HUB} wasn't found in Downloads`} bottomSeparator="none">
          Start it yourself after pressing Start recording.
        </Field>
      )}
    </ModalRoot>
  );
}

function SetupModal({
  game,
  state,
  onDone,
  closeModal,
}: {
  game: SupportedGame;
  state: VrSetupState;
  onDone: () => void;
  closeModal?: () => void;
}) {
  const [files, setFiles] = useState<{ path: string; ok: boolean }[] | null>(null);
  const s = state.setup!;
  const bad = s.missing + s.changed;
  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <Field label={`VR setup - ${game.displayName}`} bottomSeparator="none">
        {s.count} file{s.count === 1 ? "" : "s"} kept for the VR setup, recorded {when(s.recordedAt)}.{" "}
        {bad
          ? `${bad} of them ${bad === 1 ? "is" : "are"} missing or replaced (e.g. ${s.examples.join(", ")}). ` +
            "A game update or a mod may have undone part of the VR setup: run the VR tool again for this " +
            "game, using Record more so the new files are kept."
          : "All of them are still in place."}
        {state.kept ? ` The plugin has left ${state.kept} of them in place for you this session.` : ""}
      </Field>
      {state.hub && (
        <ButtonItem layout="below" onClick={() => void openVrHub("")}>
          Open {HUB}
        </ButtonItem>
      )}
      <ButtonItem
        layout="below"
        description="Record again after changing or repairing the VR setup; new files are added"
        onClick={async () => {
          closeModal?.();
          await start(game, !!state.hub, onDone);
        }}
      >
        Record more…
      </ButtonItem>
      <ButtonItem
        layout="below"
        onClick={() => void getVrFiles(game.nexusDomain).then((r) => setFiles(r.files ?? []))}
      >
        Show the files
      </ButtonItem>
      {files && (
        <Field label="Files" bottomSeparator="none">
          {files.length
            ? files.map((f) => `${f.ok ? "" : "⚠ "}${f.path}`).join(" · ")
            : "None"}
        </Field>
      )}
      <ButtonItem
        layout="below"
        description="Stop keeping these files. Nothing is deleted."
        onClick={() =>
          showModal(
            <ConfirmModal
              strTitle="Forget this VR setup?"
              strDescription="The files stay where they are, but the plugin no longer protects them from uninstalls and restores."
              strOKButtonText="Forget"
              onOK={async () => {
                await forgetVrSetup(game.nexusDomain);
                closeModal?.();
                onDone();
              }}
            />
          )
        }
      >
        Forget VR setup
      </ButtonItem>
    </ModalRoot>
  );
}

/** Rows for the Installed Mods section of the current game. */
export function VrSetupRows({ game }: { game: SupportedGame }) {
  const [state, setState] = useState<VrSetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    void getVrSetup(game.nexusDomain, game.installDirName)
      .then(setState)
      .catch(() => setState(null));
  useEffect(load, [game.nexusDomain]);
  if (!state) return null;

  if (state.recording) {
    return (
      <>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            description={`Recording since ${when(state.started)}. Finish once the VR tool is done with this game.`}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await finishVrRecording(game.nexusDomain);
                toaster.toast({
                  title: r.ok
                    ? `VR setup recorded: ${r.new ?? 0} file${r.new === 1 ? "" : "s"}`
                    : "Couldn't finish recording",
                  body: r.ok ? r.warning ?? `${r.protected ?? 0} files kept for ${game.displayName}` : r.error ?? "",
                });
              } finally {
                setBusy(false);
                load();
              }
            }}
          >
            {busy ? "Comparing files…" : "Finish VR recording"}
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy}
            onClick={async () => {
              await cancelVrRecording(game.nexusDomain);
              load();
            }}
          >
            Cancel recording
          </ButtonItem>
        </PanelSectionRow>
      </>
    );
  }

  const s = state.setup;
  const bad = s ? s.missing + s.changed : 0;
  return (
    <PanelSectionRow>
      <ButtonItem
        layout="below"
        description={
          !s
            ? `Before setting up VR with ${HUB} or another VR tool, so the plugin keeps its files`
            : bad
              ? `${bad} VR file${bad === 1 ? "" : "s"} missing or replaced - a game update may have undone it`
              : `${s.count} file${s.count === 1 ? "" : "s"} kept, recorded ${when(s.recordedAt)}`
        }
        onClick={() =>
          showModal(
            s ? (
              <SetupModal game={game} state={state} onDone={load} />
            ) : (
              <StartModal game={game} hub={state.hub} onDone={load} />
            )
          )
        }
      >
        {!s ? "Record VR setup…" : bad ? "VR setup needs attention…" : "VR setup ✓"}
      </ButtonItem>
    </PanelSectionRow>
  );
}
