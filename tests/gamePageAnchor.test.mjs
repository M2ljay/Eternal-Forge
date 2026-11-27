// Game-page anchor tests. Run via: pnpm run test:anchor
// (compiles src/gamePageAnchor.ts standalone, then executes this file)
// Decky 3.3.1 hands plugins @decky/ui 4 (webpack Steam), Decky 4.0 hands them
// @decky/ui 5 (ES-module Steam, renamed classes). Both must place the section,
// and a page without the overview panel must get nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { findInsertionChildren, overviewIndex, resolveClassModule } from "../.test-build/gamePageAnchor.js";

function find(node, filter, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return undefined;
  seen.add(node);
  if (filter(node)) return node;
  for (const child of Object.values(node)) {
    const found = find(child, filter, seen);
    if (found) return found;
  }
  return undefined;
}

const panel = () => ({ props: { className: "panel", children: { props: { overview: { appid: 1 }, details: {}, bFastRender: false } } } });
function page(innerClass) {
  const children = [{ props: { className: "header" } }, panel()];
  return { children, tree: { props: { children: { props: { className: innerClass, children } } } } };
}

test("the overview panel is recognised by its props", () => {
  assert.equal(overviewIndex([{}, panel()]), 1);
  assert.equal(overviewIndex([{ props: { children: { props: { overview: {} } } } }]), -1);
});

test("Decky 3.3.1: InnerContainer is found by its class", () => {
  const { children, tree } = page("x InnerContainer_abc");
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), children);
});

test("Decky 4.0: a stale or missing class still finds the panel's parent", () => {
  const { children, tree } = page("aqfOaplliDM-");
  assert.equal(findInsertionChildren(tree, find, "stale-class"), children);
  assert.equal(findInsertionChildren(tree, find, undefined), children);
});

test("a page without the overview panel gets nothing", () => {
  const tree = { props: { children: { props: { className: "InnerContainer_abc", children: [{ props: {} }] } } } };
  assert.equal(findInsertionChildren(tree, find, "InnerContainer_abc"), undefined);
  assert.equal(findInsertionChildren(null, find, undefined), undefined);
});

const classes = { InnerContainer: "ic", HeaderLoaded: "hl" };

test("the named class module wins when it has the key", () => {
  let probed = false;
  const ui = { appDetailsClasses: classes, findClassModule: () => { probed = true; } };
  assert.equal(resolveClassModule(ui, "appDetailsClasses", ["InnerContainer"]), classes);
  assert.equal(probed, false);
});

test("Decky 3.3.1 falls back to findClassModule, Decky 4.0 to findVar", () => {
  const pick = (values) => (filter) => values.find((v) => filter(v));
  assert.equal(resolveClassModule({ findClassModule: pick([{ a: "b" }, classes]) }, "appDetailsClasses", ["InnerContainer"]), classes);
  assert.equal(
    resolveClassModule({ appDetailsClasses: {}, findClassModule: () => undefined, findVar: pick([7, null, classes]) }, "appDetailsClasses", ["InnerContainer"]),
    classes
  );
});

test("missing, throwing or wrong answers fail soft", () => {
  const boom = () => { throw new Error("hostile"); };
  assert.equal(resolveClassModule(undefined, "appDetailsClasses", ["InnerContainer"]), undefined);
  assert.equal(resolveClassModule({ findClassModule: boom, findVar: boom }, "appDetailsClasses", ["InnerContainer"]), undefined);
  assert.equal(resolveClassModule({ findClassModule: () => ({ Other: "x" }) }, "appDetailsClasses", ["InnerContainer"]), undefined);
  const hostile = Object.defineProperty({}, "appDetailsClasses", { get: boom });
  assert.equal(resolveClassModule(hostile, "appDetailsClasses", ["InnerContainer"]), undefined);
});
