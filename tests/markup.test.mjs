// The page and its scripts are wired together by element id, which nothing else
// checks: renaming a control in index.html leaves a $("...") in the scripts that
// returns null, and the first one to be assigned a handler throws and stops the rest
// of the page from setting up. That is how the Explore toggle broke.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const at = (name) =>
  readFileSync(new URL(`../src/eye_tracking/static/${name}`, import.meta.url), "utf8");
const html = at("index.html");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test("every element the scripts look up exists in the page", () => {
  for (const script of ["app.mjs", "explore.mjs", "explore-view.mjs"]) {
    const source = at(script);
    const used = new Set([...source.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));
    for (const id of used)
      assert.ok(ids.has(id), `${script} looks up #${id}, which the page does not have`);
  }
});

test("every label points at a control that exists", () => {
  for (const [, id] of html.matchAll(/\bfor="([^"]+)"/g))
    assert.ok(ids.has(id), `a label points at #${id}, which the page does not have`);
});
