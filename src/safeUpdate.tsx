// Updating without leaving a half-copied plugin, and saying so when one is
// left anyway. The reasoning lives in pluginUpdate.ts (handOffToDecky) and
// main.py (prepare_plugin_update, get_install_integrity).
import {
  ButtonItem,
  ConfirmModal,
  PanelSection,
  PanelSectionRow,
  showModal,
} from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";

import { getInstallIntegrity, getReinstallTarget, preparePluginUpdate } from "./api";
import {
  DECKY_INSTALL_TYPE_REINSTALL,
  DECKY_INSTALL_TYPE_UPDATE,
  HandOffHooks,
  InstallIntegrity,
  handOffToDecky,
  integrityNotice,
} from "./pluginUpdate";

/** The page's half of a hand-off: ask the backend, and ask the user before
 * Forge closes its own tools. */
export const UPDATE_HOOKS: HandOffHooks = {
  prepare: (close) => preparePluginUpdate(close),
  confirmClose: (helpers, message) =>
    new Promise<boolean>((resolve) => {
      let answered = false;
      const answer = (v: boolean) => {
        if (!answered) {
          answered = true;
          resolve(v);
        }
      };
      const modal = showModal(
        <ConfirmModal
          strTitle="Close Forge's tools first?"
          strDescription={
            (message || `Forge will close ${helpers.join(", ")} before updating.`) +
            " Anything they were doing stops."
          }
          strOKButtonText="Close them and update"
          strCancelButtonText="Not now"
          onOK={() => answer(true)}
          onCancel={() => answer(false)}
          closeModal={() => {
            modal.Close();
            setTimeout(() => answer(false), 0);
          }}
        />
      );
    }),
};

/** Shown at the top of the panel only when the installed copy does not
 * match its manifest (or a module failed to load). One sentence, one
 * button, reachable with the D-pad. */
export function IntegrityNotice() {
  const [state, setState] = useState<InstallIntegrity | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (tries: number) =>
      getInstallIntegrity()
        .then((r) => {
          if (stale) return;
          setState(r);
          // The hashes take a moment after start; ask again until decided.
          if (r?.status === "checking" && tries > 0) {
            timer = setTimeout(() => ask(tries - 1), 2000);
          }
        })
        .catch(() => {});
    ask(15);
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
  const notice = integrityNotice(state);
  if (!notice) return null;
  return (
    <PanelSection title="Needs a reinstall">
      <PanelSectionRow>
        <div style={{ fontSize: "13px", lineHeight: 1.4, marginBottom: "6px" }}>{notice}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const target = await getReinstallTarget();
              if (!target?.ok) {
                toaster.toast({ title: "Forge", body: target?.message || "The release channel could not be reached." });
                return;
              }
              if (target.message) toaster.toast({ title: "Forge", body: target.message });
              const err = await handOffToDecky(
                target,
                target.same_version ? DECKY_INSTALL_TYPE_REINSTALL : DECKY_INSTALL_TYPE_UPDATE,
                UPDATE_HOOKS
              );
              toaster.toast({
                title: "Forge",
                body: err || "Decky will ask you to confirm the reinstall.",
              });
            } catch (e) {
              toaster.toast({ title: "Forge", body: `The reinstall could not start: ${String(e)}` });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Asking Decky…" : `Reinstall ${state?.label || "Forge"}`}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}
