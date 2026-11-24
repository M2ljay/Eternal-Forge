// A GameBanana mod's page: its pictures, its description as plain text, and
// its files. Installing goes through installModWith - the same per-game
// pipeline, Downloads tracking, FOMOD wizard and folder choice as a Nexus
// mod - so it lands in My Mods like any other, tagged GameBanana.
import { DialogButton, Focusable, ScrollPanelGroup, showModal } from "@decky/ui";
import { addEventListener, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaArrowDown, FaEye, FaThumbsUp } from "react-icons/fa";

import { GB_ID_BASE, GbFile, GbMod, InstallProgress, gbGetMod } from "./api";
import { PayloadChoiceModal } from "./ChoiceModal";
import { PageBackdrop, SectionHeading, StatChip, WarningBox } from "./chrome";
import { FomodWizardData, FomodWizardModal } from "./FomodWizard";
import { GB_YELLOW, fmtBytes, fmtDate, getGbGame, getGbModId } from "./gamebanana";
import { finishFomod, installModWith, removeMod, toggleMod } from "./install";
import { nameDownload } from "./state";
import { popOurPage } from "./Tabs";
import { NEXUS_ORANGE, PAGE_SCROLLER } from "./theme";

const Scroller: any = ScrollPanelGroup;
const DESC_COLLAPSE = 600;

export function GameBananaModPage() {
  const game = getGbGame();
  const gbId = getGbModId();
  const [mod, setMod] = useState<GbMod | undefined>();
  const [installed, setInstalled] = useState<{ folder: string; file_id: number; enabled: boolean }[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<number | undefined>();
  const [progress, setProgress] = useState<InstallProgress | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const refresh = async () => {
    if (!game || !gbId) return;
    const r = await gbGetMod(game.nexusDomain, gbId);
    if (r.ok && r.mod) {
      setMod(r.mod);
      setInstalled(r.installed ?? []);
    } else {
      setError(r.error ?? "Could not load the mod");
    }
  };

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
    // Only this mod's events; its pipeline id is GameBanana's id moved past
    // GB_ID_BASE, known before the page has loaded.
    const mine = gbId ? GB_ID_BASE + gbId : -1;
    const listener = addEventListener<[p: InstallProgress]>("install_progress", (p) =>
      setProgress((prev) => (p.mod_id === mine ? p : prev))
    );
    return () => removeEventListener("install_progress", listener);
  }, []);

  if (!game || !gbId) {
    return <div style={{ marginTop: "60px", padding: "20px" }}>No mod selected.</div>;
  }

  const install = async (file: GbFile, payloadChoice = "") => {
    if (!mod) return;
    setBusy(file.file_id);
    setProgress(undefined);
    setNote(undefined);
    nameDownload(mod.mod_id, mod.name, game.appId);
    const version = file.version || mod.version || fmtDate(file.date);
    try {
      const result = await installModWith(
        game,
        mod.mod_id,
        file.file_id,
        file.file_name,
        mod.name,
        version,
        "gamebanana",
        version,
        "",
        payloadChoice
      );
      if (result.needs_fomod && result.fomod_token && result.wizard) {
        showModal(
          <FomodWizardModal
            wizard={result.wizard as FomodWizardData}
            onInstall={async (ids) => {
              nameDownload(mod.mod_id, mod.name, game.appId);
              const done = await finishFomod(result.fomod_token!, ids);
              toaster.toast({ title: done.ok ? `${mod.name} installed` : "Install failed", body: done.error ?? "" });
              refresh();
            }}
          />
        );
        return;
      }
      if (result.needs_choice && result.options?.length) {
        showModal(
          <PayloadChoiceModal
            modName={mod.name}
            options={result.options}
            labels={result.option_labels}
            allowMerge={result.merge_allowed !== false}
            onPick={(opt) => install(file, opt)}
          />
        );
        return;
      }
      if (result.ok) {
        if (result.warning) setNote(result.warning);
        toaster.toast({
          title: result.unverified ? `${mod.name} installed - but check it` : `${mod.name} installed`,
          body: `It will load next time ${game.displayName} starts.`,
        });
      } else {
        setNote(result.error ?? "Install failed");
        toaster.toast({ title: "Install failed", body: result.error ?? "Unknown error" });
      }
    } catch (e) {
      toaster.toast({ title: "Install failed", body: String(e) });
    } finally {
      setBusy(undefined);
      setProgress(undefined);
      refresh();
    }
  };

  const progressText =
    progress && mod && progress.mod_id === mod.mod_id
      ? progress.phase === "downloading"
        ? `Downloading… ${progress.percent}%`
        : progress.phase === "extracting"
        ? "Extracting…"
        : "Installing…"
      : "Installing…";

  const installedIds = new Set(installed.map((i) => i.file_id));
  const text = mod?.text ?? "";
  const long = text.length > DESC_COLLAPSE;

  return (
    <Focusable onCancel={() => popOurPage()} style={{ marginTop: "40px", height: "calc(100% - 40px)" }}>
      <Scroller focusable={false} style={PAGE_SCROLLER}>
        <PageBackdrop src={mod?.images[0] || mod?.thumbnail} height={250} />
        <div style={{ position: "relative", zIndex: 1 }}>
          {error && <div style={{ padding: "20px 0", color: NEXUS_ORANGE }}>GameBanana: {error}</div>}
          {!mod && !error && <div style={{ padding: "20px 0", opacity: 0.8 }}>Loading…</div>}
          {mod && (
            <>
              <div style={{ display: "flex", gap: "16px", padding: "14px 0", alignItems: "flex-start" }}>
                {mod.thumbnail && (
                  <img
                    src={mod.thumbnail}
                    alt=""
                    style={{ width: "280px", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "6px", flexShrink: 0 }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: GB_YELLOW, letterSpacing: "0.5px" }}>
                    GAMEBANANA{mod.category ? ` · ${mod.category}` : ""}
                  </div>
                  <h2 style={{ margin: "2px 0 4px" }}>{mod.name}</h2>
                  <div style={{ opacity: 0.75, fontSize: "13px", marginBottom: "8px" }}>
                    by {mod.author || "unknown"}
                    {mod.game_name ? ` · ${mod.game_name}` : ""}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    <StatChip icon={<FaThumbsUp size={11} />}>{mod.likes.toLocaleString()}</StatChip>
                    <StatChip icon={<FaArrowDown size={11} />}>{mod.downloads.toLocaleString()}</StatChip>
                    <StatChip icon={<FaEye size={11} />}>{mod.views.toLocaleString()}</StatChip>
                    {mod.version && <StatChip>v{mod.version}</StatChip>}
                    {mod.added ? <StatChip>uploaded {fmtDate(mod.added)}</StatChip> : null}
                    {mod.updated && mod.updated !== mod.added ? <StatChip>updated {fmtDate(mod.updated)}</StatChip> : null}
                  </div>
                  {mod.summary && <div style={{ marginTop: "8px", opacity: 0.85 }}>{mod.summary}</div>}
                </div>
              </div>

              {mod.withheld && (
                <WarningBox
                  title="Withheld on GameBanana"
                  body="GameBanana has this mod withheld or removed; its files may not download."
                />
              )}
              {note && <WarningBox title="Note" body={note} />}
              {mod.requirements.length > 0 && (
                <WarningBox
                  title="The author lists these as needed"
                  body={`${mod.requirements.map((r) => r.name).join(", ")}. Install them first; they are not installed for you.`}
                />
              )}

              <SectionHeading title={`Files (${mod.files.length})`} />
              {mod.files.length === 0 && (
                <div style={{ opacity: 0.8 }}>
                  {mod.external_only
                    ? "This mod's files are hosted outside GameBanana, so they can't be installed from here."
                    : "This mod has no files to download."}
                </div>
              )}
              <Focusable style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {mod.files.map((f, i) => (
                  <Focusable
                    key={f.gb_file_id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "8px 12px",
                      borderRadius: "6px",
                      background: "rgba(255,255,255,0.06)",
                    }}
                  >
                    <div style={{ flexGrow: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {f.name}
                        {i === 0 && mod.files.length > 1 ? <span style={{ opacity: 0.6, fontWeight: 400 }}> · newest</span> : null}
                      </div>
                      <div style={{ fontSize: "12px", opacity: 0.7 }}>
                        {[f.version && `v${f.version}`, f.size ? fmtBytes(f.size) : "", fmtDate(f.date),
                          `${f.downloads.toLocaleString()} downloads`].filter(Boolean).join(" · ")}
                      </div>
                      {f.description && <div style={{ fontSize: "12px", opacity: 0.8 }}>{f.description}</div>}
                      {(f.scan || f.has_exe) && (
                        <div style={{ fontSize: "12px", color: NEXUS_ORANGE }}>
                          {f.scan ? `GameBanana's file scan: ${f.scan}. ` : ""}
                          {f.has_exe ? "Contains a program (.exe)." : ""}
                        </div>
                      )}
                    </div>
                    <DialogButton
                      disabled={busy !== undefined}
                      onClick={() => install(f)}
                      style={{ width: "200px", minWidth: 0, flexShrink: 0 }}
                    >
                      {busy === f.file_id ? progressText : installedIds.has(f.file_id) ? "Reinstall" : "Install"}
                    </DialogButton>
                  </Focusable>
                ))}
              </Focusable>

              {installed.length > 0 && (
                <>
                  <SectionHeading title="Installed" />
                  <Focusable style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {installed.map((i) => (
                      <Focusable key={i.folder} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                        <div style={{ flexGrow: 1 }}>
                          {i.folder} <span style={{ opacity: 0.6 }}>· {i.enabled ? "on" : "off"}</span>
                        </div>
                        <DialogButton
                          disabled={busy !== undefined}
                          style={{ width: "140px", minWidth: 0 }}
                          onClick={async () => {
                            const r = await toggleMod(game, i.folder, !i.enabled);
                            if (!r.ok) toaster.toast({ title: "Could not switch it", body: r.error ?? "" });
                            refresh();
                          }}
                        >
                          {i.enabled ? "Switch off" : "Switch on"}
                        </DialogButton>
                        <DialogButton
                          disabled={busy !== undefined}
                          style={{ width: "140px", minWidth: 0 }}
                          onClick={async () => {
                            const r = await removeMod(game, i.folder);
                            toaster.toast({ title: r.ok ? `${mod.name} removed` : "Uninstall failed", body: r.error ?? "" });
                            refresh();
                          }}
                        >
                          Uninstall
                        </DialogButton>
                      </Focusable>
                    ))}
                  </Focusable>
                </>
              )}

              {text && (
                <>
                  <SectionHeading title="About" />
                  <Focusable onActivate={() => long && setExpanded(!expanded)}>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, opacity: 0.9 }}>
                      {long && !expanded ? `${text.slice(0, DESC_COLLAPSE)}…` : text}
                    </div>
                    {long && (
                      <div style={{ color: NEXUS_ORANGE, fontSize: "13px", marginTop: "4px" }}>
                        {expanded ? "Show less" : "Show more"}
                      </div>
                    )}
                  </Focusable>
                </>
              )}

              {mod.images.length > 1 && (
                <>
                  <SectionHeading title="Pictures" />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" }}>
                    {mod.images.slice(0, 8).map((u) => (
                      <img key={u} src={u} alt="" loading="lazy" style={{ width: "100%", borderRadius: "6px" }} />
                    ))}
                  </div>
                </>
              )}
              <div style={{ fontSize: "12px", opacity: 0.5, margin: "16px 0" }}>{mod.url}</div>
            </>
          )}
        </div>
      </Scroller>
    </Focusable>
  );
}
