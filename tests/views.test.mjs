import test from "node:test";
import assert from "node:assert/strict";
import {
  canDriveMechanism,
  isLocal,
  startingView,
} from "../src/eye_tracking/static/views.mjs";

const at = (href) => new URL(href);

test("the published site opens on the play page, a local one on diagnostics", () => {
  assert.equal(startingView(at("https://ricklon.github.io/eye-tracking/")), "play");
  assert.equal(startingView(at("http://127.0.0.1:8080/")), "diagnostics");
  assert.equal(startingView(at("http://localhost:8080/")), "diagnostics");
  // Either page can be asked for by address, so a link goes where it says.
  assert.equal(startingView(at("https://ricklon.github.io/eye-tracking/?diagnostics=1")), "diagnostics");
  assert.equal(startingView(at("http://127.0.0.1:8080/?play=1")), "play");
});

test("a page that cannot reach the board does not offer the mechanism", () => {
  assert.equal(canDriveMechanism(at("https://ricklon.github.io/eye-tracking/")), false);
  // Not even over HTTPS on this machine: the board speaks plain ws://.
  assert.equal(canDriveMechanism(at("https://localhost:8080/")), false);
  assert.equal(canDriveMechanism(at("http://127.0.0.1:8080/")), true);
  // A LAN address is neither a secure origin for the camera nor an allowed origin.
  assert.equal(isLocal(at("http://192.168.1.39:8080/")), false);
  // ...unless the local bridge answered, which only a local server does.
  assert.equal(canDriveMechanism(at("http://192.168.1.39:8080/"), { port: 8766 }), true);
});
