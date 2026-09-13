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

HTTP currently exposes `/api/look` in degrees, `/api/blink`, `/api/lid_trim`, and
`/api/lid_coeff`. `/api/anim` plays built-in named animations; it does not upload a
tracking recording or stream arbitrary `eye_frame_t` poses. Independent upper/lower
measurements exceed the paired-lid animation structure and would need an extension
if all four lids are to be driven independently. `/api/lid_trim` modifies lid limits
and should not be treated as a per-frame opening command.

Suggested development sequence:

1. Record looking left/right/up/down, blinking, and winking; verify side assignment
   and robustness with head movement and glasses.
2. Calibrate neutral iris position, useful gaze range, and open/closed lids per eye.
   Store these separately from the mechanism's servo calibration.
3. Render a software mechanism preview. Combine valid eyes for shared gaze, hold
   gaze through a blink, smooth by elapsed time, and choose a face-loss timeout and
   neutral behavior. Face reacquisition is not identity tracking.
4. Convert recordings into calibrated, rate-limited normalized animation keyframes.
5. Add a firmware pose/keyframe interface or generate built-in animation tables.
   Preserve the existing release latch, measured travel limits, and explicit engage
   behavior. Test against the software preview before connecting hardware.

This project currently emits measurements and renders software eyes through the
desktop kiosk and [browser dashboard](web.md). The browser runs MediaPipe locally;
a future bridge must connect its output to the calibrated hardware adapter.
No hardware neutral pose, angle limits, network address, or live actuation behavior
is assumed.
