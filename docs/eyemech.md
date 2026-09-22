# Eyemech integration notes

Source inspected: sibling `eyemech-esp32-xiao`, especially
`components/eye_motion/include/eye_motion.h`, `components/eye_motion/eye_motion.c`,
and the HTTP routes in `components/eye_web/eye_web.c`.
The README there does not yet describe all of the animation features in source.

The mechanism has shared LR/UD gaze axes and four eyelid servos: TL, BL, TR, BR.
Its internal `eye_frame_t` animation structure already uses:

| Field | Firmware meaning | Future tracker adapter |
| --- | --- | --- |
| `lr`, `ud` | 0..1 across calibrated axis limits | Neutral-calibrated iris displacement; configurable gain and inversion |
| `lid_l`, `lid_r` | Independent left/right paired lids, 0 closed..1 open | Calibrated per-eye openness |
| `ms` | Travel duration from the preceding keyframe | Resampled recording timestamp differences |

Firmware normalized min/max endpoints can run in either numerical angle direction.
Do not assume camera-right maps to firmware `lr=1`. Preserve anatomical side names
until the adapter explicitly maps them to physical eyes.

HTTP exposes `/api/look` in degrees, `/api/blink`, `/api/lid_trim`, and
`/api/lid_coeff`; `/api/anim` plays built-in named animations only. `/api/lid_trim`
modifies lid limits and is not a per-frame opening command.

## Follow mode (firmware 2026-09-17)

The firmware's follow mode takes live poses over `/ws/pose` (also `POST /api/pose`
and `!pose`): `lr`, `ud` and one value per lid servo, `lid_tl`, `lid_bl`, `lid_tr`,
`lid_br`, each 0..1. Lid 1.0 is the trimmed open position, not the calibrated max.
Sides are the mechanism's own; mirroring is the sender's decision. The 100 Hz motion
task slews each servo toward the latest pose at most 300°/s (gaze) and 600°/s (lids).
No timer blinks run while following. One second without a pose, or `{"stop":true}`,
eases back to neutral and the previous mode. Poses are refused while released or in
standby, calibration or an animation. The socket refuses cross-origin browsers apart from configured origins (below),
and a native sender must set `TCP_NODELAY` or a 30 Hz stream arrives in bursts.

### Connecting the dashboard

The staff panel **Drive the mechanism** connects one of two ways:

- **Direct (default):** the browser opens `ws://<board>/ws/pose` itself. This needs
  firmware whose `CONFIG_EYE_WEB_EXTRA_ORIGINS` (menuconfig → *eyemech web*) admits
  this page's origin. Its default, `http://localhost:8080,http://127.0.0.1:8080`,
  matches `just web`, so serve the page on port 8080. Older firmware refuses the
  page, and a refused origin looks the same to a page as an unreachable board. It
  cannot work from the HTTPS GitHub Pages copy, which may not open `ws://`. The
  connection choice and board address are remembered in the browser.
- **Bridge:** `just web --eyemech eyemech.local` (or `HOST:PORT`, or a full `ws://`
  URI) also starts a local WebSocket bridge on `--bridge-port` (default 8766).
  Use it for firmware without the origin option. It accepts only the dashboard's
  own origin and one dashboard at a time. It validates each message against the
  follow schema and relays it with `TCP_NODELAY`. It passes board refusals back
  to the page and sends a stop when the page disconnects.

Both are WebSockets end to end. `TCP_NODELAY` is the socket option the firmware
notes ask native senders to set; browsers already set it.

The panel maps the displayed pose (`static/eyemech.mjs`):

- `lr`/`ud` = 0.5 ± display gaze × gaze range / 2, with left/right and up/down
  reversal settings, because which end of each axis is which varies by build.
- **Mirror sides** (default on) sends your left eye to the mechanism's right lids
  (TR/BR), matching the on-screen eyes, which face you.
- **Decisive lids** (default on): each eye is sent fully open or fully closed.
  It closes when the displayed upper lid drops below 0.3 and reopens above 0.6,
  held closed at least 150 ms so a one-frame blink completes its stroke
  (`LidGate`). Squints and landmark jitter between the thresholds never reach the
  servos, which otherwise follow every wobble at 600°/s. Off, upper and lower lids
  pass through as the dashboard shows them (lid gain, sqrt-shaped lower lid).
  Echo delay applies either way.

The page streams about 50 Hz from its animation loop and drops a frame rather than
queueing one behind a slow socket. Smoothing happens in the dashboard controller
(time-based easing, blink latch), and the firmware only rate-limits. Poses are sent
while greeting, copying, following or briefly waiting. Otherwise one stop is sent and
the board returns to its own mode. The mapping has no person calibration yet:
gaze range is a single gain around the display's neutral.

Suggested development sequence:

1. Record looking left/right/up/down, blinking, and winking; verify side assignment
   and robustness with head movement and glasses.
2. Calibrate neutral iris position, useful gaze range, and open/closed lids per eye.
   Store these separately from the mechanism's servo calibration.
3. ✅ Render a software mechanism preview. Combine valid eyes for shared gaze, hold
   gaze through a blink, smooth by elapsed time, and choose a face-loss timeout and
   neutral behavior. Face reacquisition is not identity tracking.
4. Convert recordings into calibrated, rate-limited normalized animation keyframes.
5. ✅ (live poses: follow mode + bridge above) Add a firmware pose/keyframe interface or generate built-in animation tables.
   Preserve the existing release latch, measured travel limits, and explicit engage
   behavior. Test against the software preview before connecting hardware.

The dashboard can now stream live poses directly or through the bridge. Still open: an
on-mechanism check of the default gaze directions and side mirroring, per-person
gaze-range calibration, and converting recordings into keyframes (step 4). No
hardware neutral pose, angle limits or network address is assumed here.
