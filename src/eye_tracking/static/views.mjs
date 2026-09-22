// Which page a visitor gets. The published site is for playing with: big eyes, one
// button, the wink lab. Everything for building and debugging — camera controls,
// per-eye readings, recording, the mechanism — lives behind ?diagnostics=1, which is
// also where `just web` starts, since that is someone working on it.
export function startingView(location, local = isLocal(location)) {
  const params = new URLSearchParams(location.search ?? "");
  if (params.has("play")) return "play";
  return params.has("diagnostics") || local ? "diagnostics" : "play";
}
// Served from this machine over plain HTTP: the camera works on localhost, and the
// board accepts this origin. A published HTTPS page is neither.
export function isLocal(location) {
  return (
    location.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)
  );
}
// The mechanism can only be driven from a local page: an HTTPS page may not open a
// plain ws:// socket to the board, and the board only admits localhost origins.
export function canDriveMechanism(location, bridge = null) {
  return Boolean(bridge) || isLocal(location);
}
