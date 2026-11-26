// Updating the plugin itself, from Gaming Mode. Run via:
// pnpm run test:pluginupdate
import assert from "node:assert/strict";
import test from "node:test";

import {
  DECKY_INSTALL_TYPE_REINSTALL,
  DECKY_INSTALL_TYPE_UPDATE,
  FORK_RELEASE_RAW,
  PLUGIN_NAME,
  UPDATE_WAIT_MS,
  canSelfUpdate,
  formatReleaseNotes,
  handOffToDecky,
  integrityNotice,
  isNewerVersion,
  pluginUpdateBlocked,
  pluginUpdateBody,
  pluginUpdateLabel,
  requestPluginUpdate,
  trustedArtifact,
  trustedHash,
  updateLanded,
  versionParts,
} from "../.test-build/pluginUpdate.js";

const REAL = "https://raw.githubusercontent.com/M2ljay/Eternal-Forge/release/Nexus-Mods.zip";

function withRouter(fn, impl) {
  const prev = globalThis.window;
  globalThis.window = { DeckyBackend: impl };
  try {
    return fn();
  } finally {
    globalThis.window = prev;
  }
}

// --- version comparison --------------------------------------------------

test("a newer version is offered and an older one is not", () => {
  assert.equal(isNewerVersion("1.11.1", "1.11.2"), true);
  assert.equal(isNewerVersion("1.11.2", "1.11.2"), false, "equal is not an update");
  assert.equal(isNewerVersion("1.11.2", "1.11.1"), false, "never a downgrade");
});

test("1.9.9 is older than 1.11.0, whatever a string compare thinks", () => {
  // This is the whole reason the comparison is numeric. A string compare
  // puts "1.9.9" above "1.11.0" and would have offered a downgrade on the
  // day this shipped, since the plugin went 1.9.8 to 1.10.0 to 1.11.x.
  assert.equal(isNewerVersion("1.9.9", "1.11.0"), true);
  assert.equal(isNewerVersion("1.11.0", "1.9.9"), false);
  assert.equal(isNewerVersion("1.9.8", "1.10.0"), true);
});

test("a dev build ahead of the store is left alone", () => {
  // The test device usually runs a version that is not published yet.
  // Nagging it to install an older build would be worse than silence.
  assert.equal(isNewerVersion("1.12.0", "1.11.2"), false);
});

test("version parsing never throws on rubbish", () => {
  assert.deepEqual(versionParts("1.11.2"), [1, 11, 2]);
  assert.deepEqual(versionParts("v1.11.2"), [1, 11, 2]);
  assert.deepEqual(versionParts("1.11.2-beta"), [1, 11, 2]);
  for (const bad of ["", "   ", "abc", "..", undefined, null]) {
    assert.doesNotThrow(() => versionParts(bad));
    assert.equal(isNewerVersion("1.0.0", bad), false, String(bad));
  }
});

test("a missing latest version is not an update", () => {
  assert.equal(isNewerVersion("1.0.0", ""), false);
});

// --- what may be installed ----------------------------------------------

test("only this fork's own release channel is trusted", () => {
  // Decky installs whatever URL it is handed, so this is the last check
  // on our side before something else's code runs as this plugin.
  assert.equal(FORK_RELEASE_RAW, "https://raw.githubusercontent.com/M2ljay/Eternal-Forge/release/");
  assert.equal(trustedArtifact(REAL), true);
  assert.equal(trustedArtifact(FORK_RELEASE_RAW + "Forge-1.21.32-anygame.64.zip"), true);
  for (const bad of [
    undefined,
    "",
    "http://raw.githubusercontent.com/M2ljay/Eternal-Forge/release/Nexus-Mods.zip",
    "https://example.com/Nexus-Mods-1.11.2.zip",
    // Upstream's releases would replace the fork with upstream.
    "https://github.com/RedRanger14/decky-nexus/releases/download/v1.11.2/Nexus-Mods-1.11.2.zip",
    // The repository's name before the rename.
    "https://raw.githubusercontent.com/M2ljay/vibe-nexus/release/Nexus-Mods.zip",
    "https://raw.githubusercontent.com/someoneelse/Eternal-Forge/release/Nexus-Mods.zip",
    "https://raw.githubusercontent.com/M2ljay/Eternal-Forge/main/Nexus-Mods.zip",
    // A prefix match alone would let these walk out of the branch.
    FORK_RELEASE_RAW + "../../someone/else/main/x.zip",
    FORK_RELEASE_RAW + "%2e%2e/%2e%2e/someone/else/main/x.zip",
    FORK_RELEASE_RAW + "sub/x.zip",
    FORK_RELEASE_RAW + "Nexus-Mods.zip?x=1",
    FORK_RELEASE_RAW + "Nexus-Mods.zip#x",
    FORK_RELEASE_RAW + "update.json",
    FORK_RELEASE_RAW + ".zip",
    "https://evil.invalid/#" + REAL,
  ]) {
    assert.equal(trustedArtifact(bad), false, String(bad));
  }
});

test("only a real SHA-256 counts as a hash", () => {
  // Decky skips its own hash check when the hash is empty.
  assert.equal(trustedHash("a".repeat(64)), true);
  for (const bad of [undefined, "", "a".repeat(63), "A".repeat(64), "g".repeat(64), "a".repeat(65)]) {
    assert.equal(trustedHash(bad), false, String(bad));
  }
});

// --- the guard rails -----------------------------------------------------

const GOOD = {
  ok: true,
  current: "1.11.1",
  update_available: true,
  version: "1.11.2",
  artifact: REAL,
  hash: "43fbfc90e30536422ac6aabf3b71706d9e0a105eb5d4cdc1a1e9987bb9716b37",
};

test("nothing is said when there is no update", () => {
  const none = { ok: true, current: "1.11.2", update_available: false };
  assert.equal(pluginUpdateLabel(none), "");
  assert.equal(pluginUpdateBody(none), "");
  assert.equal(pluginUpdateBlocked(none), "");
  assert.equal(pluginUpdateLabel(undefined), "");
});

test("an untrusted or unverifiable artifact is refused, not offered", () => {
  withRouter(() => {
    assert.match(
      pluginUpdateBlocked({ ...GOOD, artifact: "https://example.com/x.zip" }),
      /could not be verified/i
    );
    assert.match(
      pluginUpdateBlocked({ ...GOOD, hash: "" }),
      /could not be verified/i
    );
    assert.equal(pluginUpdateBlocked(GOOD), "", "a good update is not blocked");
  }, { call: async () => undefined });
});

test("a Decky without the installer says so instead of doing nothing", () => {
  const prev = globalThis.window;
  globalThis.window = {};
  try {
    assert.equal(canSelfUpdate(), false);
    const why = pluginUpdateBlocked(GOOD);
    assert.match(why, /Desktop Mode/);
    // It must point somewhere, not just fail.
    assert.match(why, /README/);
  } finally {
    globalThis.window = prev;
  }
});

test("the copy says what will happen and what will not", () => {
  assert.match(pluginUpdateLabel(GOOD), /1\.11\.2/);
  const body = pluginUpdateBody(GOOD);
  assert.match(body, /1\.11\.1/, "it says which version you are on");
  assert.match(body, /confirm/i, "Decky asks before installing");
  assert.match(body, /mods, API key and settings are not/i);
  assert.doesNotMatch(body, /\u2014/, "no em dashes");
});

// --- the call itself -----------------------------------------------------

test("the loader is asked with the route and arguments it documents", async () => {
  let seen;
  const err = await withRouter(
    () => requestPluginUpdate(GOOD),
    { call: async (...args) => { seen = args; } }
  );
  assert.equal(await err, "");
  assert.equal(seen[0], "utilities/install_plugin");
  assert.equal(seen[1], GOOD.artifact);
  // The name must be plugin.json's name, which is how Decky finds the
  // installed copy, or it puts a second copy beside this one.
  assert.equal(seen[2], "Forge");
  assert.equal(PLUGIN_NAME, "Forge");
  assert.equal(seen[3], "1.11.2");
  assert.equal(seen[4], GOOD.hash);
  // 2 is UPDATE in the loader's PluginInstallType, which is what makes
  // its prompt say update rather than install.
  assert.equal(seen[5], DECKY_INSTALL_TYPE_UPDATE);
  assert.equal(DECKY_INSTALL_TYPE_UPDATE, 2);
});

test("a blocked update never reaches the loader", async () => {
  let called = false;
  const err = await withRouter(
    () => requestPluginUpdate({ ...GOOD, artifact: "https://example.com/x.zip" }),
    { call: async () => { called = true; } }
  );
  assert.equal(called, false, "an untrusted artifact was sent to Decky");
  assert.match(await err, /could not be verified/i);
});

test("a refusal from Decky is reported rather than swallowed", async () => {
  const err = await withRouter(
    () => requestPluginUpdate(GOOD),
    { call: async () => { throw new Error("boom"); } }
  );
  assert.match(await err, /Decky refused/);
  assert.match(await err, /boom/);
});

// --- recovering from a prompt that was cancelled, or an update that landed ---
// Michael updated to 1.11.4 successfully and the page sat on "Waiting for
// Decky" until he closed it. Cancelling Decky's prompt would have been the
// same dead end, because nothing tells the page either happened.

test("a wait short enough that cancelling is not a punishment", () => {
  // Michael cancelled a prompt and found 25 seconds too long to wait for
  // the button to come back. Decky's prompt appears in about a second,
  // so this only has to cover that.
  assert.ok(UPDATE_WAIT_MS >= 2_000, "too short to cover the prompt appearing");
  assert.ok(UPDATE_WAIT_MS <= 10_000, "a cancel must not mean a long wait");
});

test("the update counts as landed once the running version catches up", () => {
  assert.equal(updateLanded("1.11.4", "1.11.4"), true);
  // Ahead is landed too: a dev build installed over the top still means
  // there is nothing left to do.
  assert.equal(updateLanded("1.11.4", "1.11.5"), true);
  assert.equal(updateLanded("1.11.4", "1.11.3"), false, "still on the old build");
});

test("landing is never claimed without both versions", () => {
  assert.equal(updateLanded("1.11.4", undefined), false);
  assert.equal(updateLanded("1.11.4", ""), false);
  assert.equal(updateLanded("", "1.11.4"), false);
});

// --- release notes ------------------------------------------------------
// "it would also be great if we could put what is in the update somewhere
// as part of it" - so the notes travel with the update, not just the
// version number.

const REAL_NOTES = [
  "An unofficial, community-built Decky Loader plugin.",
  "",
  "## The plugin now updates itself",
  "",
  "Open the Quick Access Menu, press **Updates**, and a plugin update",
  "appears. No `Desktop Mode`, no terminal.",
  "",
  "## Also in this release",
  "",
  "- Beginnings of NieR:Automata, requested in [issue #25](https://x/25).",
  "- The log now names every Steam library it searched.",
  "",
  "## Installing",
  "",
  "Download `Nexus-Mods-1.11.4.zip` below.",
  "",
  "---",
  "",
  "Not affiliated with Nexus Mods or Valve.",
].join("\n");

test("nothing is shown when there are no notes", () => {
  assert.deepEqual(formatReleaseNotes(undefined), []);
  assert.deepEqual(formatReleaseNotes(""), []);
});

test("headings survive and the noise sections do not", () => {
  const lines = formatReleaseNotes(REAL_NOTES);
  const joined = lines.join("\n");
  assert.ok(lines.includes("THE PLUGIN NOW UPDATES ITSELF"));
  assert.ok(lines.includes("ALSO IN THIS RELEASE"));
  // Already installing it, so these two say nothing useful here.
  assert.doesNotMatch(joined, /INSTALLING/);
  assert.doesNotMatch(joined, /Nexus-Mods-1\.11\.4\.zip/);
  // The footer rule ends the useful part.
  assert.doesNotMatch(joined, /Not affiliated/);
});

test("markdown marks are stripped rather than shown raw", () => {
  const joined = formatReleaseNotes(REAL_NOTES).join("\n");
  assert.doesNotMatch(joined, /\*\*/, "bold markers left in");
  assert.doesNotMatch(joined, /`/, "code ticks left in");
  assert.doesNotMatch(joined, /\]\(http/, "raw link syntax left in");
  // The link's text is what a reader needs, not its URL.
  assert.match(joined, /issue #25/);
  assert.doesNotMatch(joined, /https:\/\/x\/25/);
  // Bullets stay recognisable as bullets.
  assert.match(joined, /- Beginnings of NieR:Automata/);
});

test("the notes are bounded, because this is a panel not a browser", () => {
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  assert.ok(formatReleaseNotes(huge).length <= 40);
  assert.equal(formatReleaseNotes(huge, 5).length, 5);
});

test("blank lines are kept as separators but never doubled or trailing", () => {
  const lines = formatReleaseNotes(REAL_NOTES);
  assert.notEqual(lines[lines.length - 1], "", "trailing blank left behind");
  for (let i = 1; i < lines.length; i++) {
    assert.ok(
      !(lines[i] === "" && lines[i - 1] === ""),
      `two blank lines in a row at ${i}`
    );
  }
});

test("carriage returns from a GitHub body do not survive", () => {
  const crlf = "## Heading\r\n\r\n- one\r\n- two\r\n";
  const lines = formatReleaseNotes(crlf);
  for (const l of lines) assert.doesNotMatch(l, /\r/, JSON.stringify(l));
  assert.ok(lines.includes("HEADING"));
  assert.ok(lines.includes("- one"));
});

test("the standing preamble is dropped, so changes are what you see first", () => {
  // Every release body opens with the same paragraph about what the
  // plugin is and that it needs Premium. Both true, both worthless to
  // somebody who already has it installed, and together they filled the
  // whole collapsed view and pushed the actual changes behind "Show more".
  const lines = formatReleaseNotes(REAL_NOTES);
  const joined = lines.join("\n");
  assert.doesNotMatch(joined, /unofficial, community-built/);
  assert.doesNotMatch(joined, /Premium/);
  // The first thing shown is the first real heading.
  assert.equal(lines[0], "THE PLUGIN NOW UPDATES ITSELF");
});

test("notes with no headings at all are still shown rather than swallowed", () => {
  // A release written as a plain paragraph must not come back empty:
  // skipping the preamble only makes sense when there is a heading to
  // skip TO.
  const plain = "Fixed a crash when opening the panel.\nAlso tidied the log.";
  const lines = formatReleaseNotes(plain);
  assert.ok(lines.length >= 1, "plain notes were dropped entirely");
  assert.match(lines.join("\n"), /Fixed a crash/);
});

// --- anygame.67: never hand Decky a plugin that is still busy ---------------
// Decky v3.3.1 deletes the folder and extracts over it; on Windows both stop
// at the first file still held, leaving a half-copied plugin.

function hooks({ first, second, confirm = true }) {
  const calls = [];
  return {
    calls,
    prepare: async (close) => {
      calls.push(close ? "prepare(close)" : "prepare");
      return close ? second : first;
    },
    confirmClose: async (helpers) => {
      calls.push(`confirm ${helpers.join(",")}`);
      return confirm;
    },
  };
}

test("a busy plugin is not handed to Decky", async () => {
  let called = false;
  const h = hooks({ first: { ok: false, reason: "busy", message: "Wait for a download to finish" } });
  const err = await withRouter(() => requestPluginUpdate(GOOD, h), { call: async () => { called = true; } });
  assert.equal(called, false);
  assert.match(err, /download/);
});

test("Forge's own tools are closed only after the user agrees", async () => {
  let seen;
  const h = hooks({
    first: { ok: false, reason: "helpers_running", helpers: ["7z.exe"], message: "Forge will close 7z.exe" },
    second: { ok: true, closed: ["7z.exe"] },
  });
  const err = await withRouter(() => requestPluginUpdate(GOOD, h), { call: async (...a) => { seen = a; } });
  assert.equal(err, "");
  assert.deepEqual(h.calls, ["prepare", "confirm 7z.exe", "prepare(close)"]);
  assert.equal(seen[0], "utilities/install_plugin");

  let called = false;
  const no = hooks({ first: { ok: false, reason: "helpers_running", helpers: ["x.exe"] }, confirm: false });
  const err2 = await withRouter(() => requestPluginUpdate(GOOD, no), { call: async () => { called = true; } });
  assert.equal(called, false, "declined, yet Decky was asked");
  assert.match(err2, /cancelled/);
  assert.deepEqual(no.calls, ["prepare", "confirm x.exe"]);
});

test("a backend too broken to answer cannot block its own repair", async () => {
  let seen;
  const h = { prepare: async () => { throw new Error("no such method"); }, confirmClose: async () => true };
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    const err = await withRouter(
      () => handOffToDecky({ ...GOOD }, DECKY_INSTALL_TYPE_REINSTALL, h),
      { call: async (...a) => { seen = a; } }
    );
    assert.equal(err, "");
  } finally {
    console.warn = prevWarn;
  }
  assert.equal(seen[5], 1, "REINSTALL in Decky's PluginInstallType");
  assert.equal(DECKY_INSTALL_TYPE_REINSTALL, 1);
});

test("a reinstall target is held to the same trust rules", async () => {
  let called = false;
  const err = await withRouter(
    () => handOffToDecky({ ...GOOD, artifact: REAL.replace("Nexus-Mods.zip", "../../x/y.zip") }, 1),
    { call: async () => { called = true; } }
  );
  assert.equal(called, false);
  assert.match(err, /could not be verified/);
  assert.equal(trustedArtifact(REAL.replace("Nexus-Mods.zip", "Nexus-Mods-1.21.32-anygame.67.zip")), true,
    "the pinned per-version zip must be installable");
});

test("the integrity notice is plain and only shown when needed", () => {
  assert.equal(integrityNotice(undefined), "");
  assert.equal(integrityNotice({ ok: true, status: "ok" }), "");
  assert.equal(integrityNotice({ ok: true, status: "checking" }), "");
  assert.equal(integrityNotice({ ok: true, status: "no_manifest" }), "");
  assert.equal(
    integrityNotice({ ok: true, status: "broken", label: "anygame.67" }),
    "Forge's last update didn't finish copying. Reinstall anygame.67."
  );
  assert.match(
    integrityNotice({ ok: true, status: "ok", label: "anygame.67", import_failures: { vr_feed: "SyntaxError" } }),
    /vr_feed.*Reinstall anygame\.67/
  );
});
