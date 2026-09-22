'use strict';

/* =========================================================
   Focusline - attention guard

   An on-device computer-vision check for "are you still at the
   desk, facing the screen". It runs Google's MediaPipe Face
   Landmarker: a BlazeFace CNN finds the face, a second CNN
   regresses 478 landmarks and 52 blendshape coefficients.

   Everything runs locally through WebAssembly. No frame ever
   leaves the machine, nothing is recorded, and the model is
   fetched only once the guard is switched on - so the rest of
   Focusline keeps working offline with no dependencies.

   What this can honestly see: whether a face is present, which
   way the head is turned, roughly where the eyes point, and
   whether they are shut. What it cannot see: whether you are
   thinking about work. Treat it as a nudge, not a judgement.
   ========================================================= */

(function (global) {
  const TASKS_BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
  const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  /* ~7 samples a second is ample for attention and far kinder to the
     battery than running at frame rate. */
  const SAMPLE_MS = 140;

  /* A backgrounded tab throttles timers. Capping the step means a long
     gap samples less often rather than instantly banking a huge debt. */
  const MAX_STEP_MS = 2000;

  const CALIBRATION_MS = 1600;

  /* enumerateDevices() and getUserMedia() both sit unresolved on some
     setups instead of rejecting, so neither is ever awaited unguarded. */
  const DEVICE_QUERY_MS = 2500;
  const CAMERA_OPEN_MS = 12000;

  /* Canonical MediaPipe face-mesh indices. */
  const LM = {
    nose: 1,
    chin: 152,
    forehead: 10,
    faceRight: 234,
    faceLeft: 454
  };

  const SENSITIVITY = {
    relaxed: { graceMs: 25000, yaw: 0.20, pitch: 0.22, gaze: 0.80, recovery: 2.0 },
    balanced: { graceMs: 12000, yaw: 0.15, pitch: 0.17, gaze: 0.65, recovery: 1.6 },
    strict: { graceMs: 6000, yaw: 0.11, pitch: 0.13, gaze: 0.50, recovery: 1.3 }
  };

  const REASONS = {
    away: 'You left the frame',
    eyes: 'Your eyes have been shut',
    head: 'You have been turned away from the screen',
    gaze: 'Your eyes have been off the screen',
    focused: 'Focused'
  };

  /* =========================================================
     Pure scoring - no DOM, no camera, so it can be tested directly
     ========================================================= */

  function blendshapeMap(result) {
    const shapes = {};
    const groups = result && result.faceBlendshapes;
    if (!groups || !groups.length || !groups[0] || !groups[0].categories) return shapes;
    groups[0].categories.forEach(function (category) {
      shapes[category.categoryName] = category.score;
    });
    return shapes;
  }

  function pick(shapes, name) {
    const value = shapes[name];
    return typeof value === 'number' ? value : 0;
  }

  /* Head angle is read from landmark geometry rather than the
     transformation matrix: no axis convention to get wrong, and the
     ratios are already normalised to the size of the face. */
  function readSignals(result, options) {
    const faces = result && result.faceLandmarks;
    const landmarks = faces && faces.length ? faces[0] : null;

    if (!landmarks || landmarks.length <= LM.faceLeft) {
      return { present: false, yaw: 0, pitch: 0, gaze: 0, eyesShut: false };
    }

    const nose = landmarks[LM.nose];
    const left = landmarks[LM.faceLeft];
    const right = landmarks[LM.faceRight];
    const forehead = landmarks[LM.forehead];
    const chin = landmarks[LM.chin];

    const width = Math.abs(left.x - right.x);
    const height = Math.abs(chin.y - forehead.y);

    /* 0 means the nose sits midway between the face edges. */
    const yaw = width > 1e-4 ? (nose.x - (left.x + right.x) / 2) / width : 0;
    const pitch = height > 1e-4 ? (nose.y - (forehead.y + chin.y) / 2) / height : 0;

    const shapes = blendshapeMap(result);
    const eyesShut = Math.min(pick(shapes, 'eyeBlinkLeft'), pick(shapes, 'eyeBlinkRight')) > 0.5;

    /* Looking sideways or up counts as off-screen. Looking *down* does
       not: that is usually the keyboard, a notebook or a second screen,
       which is still the work. */
    const sideways = Math.max(
      pick(shapes, 'eyeLookOutLeft'), pick(shapes, 'eyeLookOutRight'),
      pick(shapes, 'eyeLookInLeft'), pick(shapes, 'eyeLookInRight')
    );
    const upward = Math.max(pick(shapes, 'eyeLookUpLeft'), pick(shapes, 'eyeLookUpRight'));

    const signals = { present: true, yaw: yaw, pitch: pitch, gaze: Math.max(sideways, upward), eyesShut: eyesShut };
    if (options && options.raw) signals.shapes = shapes;
    return signals;
  }

  /* Decides whether a single frame counts as attention. */
  function judge(signals, tuning, centre) {
    if (!signals.present) return { attentive: false, reason: 'away' };
    if (signals.eyesShut) return { attentive: false, reason: 'eyes' };

    const yawOff = Math.abs(signals.yaw - centre.yaw) / tuning.yaw;
    const pitchOff = Math.abs(signals.pitch - centre.pitch) / tuning.pitch;
    if (yawOff > 1 || pitchOff > 1) return { attentive: false, reason: 'head' };

    if (signals.gaze > tuning.gaze) return { attentive: false, reason: 'gaze' };
    return { attentive: true, reason: 'focused' };
  }

  /* Hysteresis: inattention builds a debt, attention pays it off faster
     than it accrues. One glance at the window costs nothing; a two-minute
     phone call trips it once, not forty times. */
  function step(machine, attentive, dtMs, tuning) {
    /* The debt is capped at the threshold rather than allowed to pile up.
       Without the cap, a ten-minute lunch banks ten minutes of debt and
       you would have to sit perfectly still on your return before the
       guard believed you. Capped, recovery always takes the same few
       seconds however long you were gone. */
    if (attentive) machine.debt = Math.max(0, machine.debt - dtMs * tuning.recovery);
    else machine.debt = Math.min(tuning.graceMs, machine.debt + dtMs);

    if (!machine.flagged && machine.debt >= tuning.graceMs) {
      machine.flagged = true;
      return 'lost';
    }
    if (machine.flagged && machine.debt <= tuning.graceMs * 0.2) {
      machine.flagged = false;
      return 'regained';
    }
    return null;
  }

  function newMachine() {
    return { debt: 0, flagged: false };
  }

  /* =========================================================
     Runtime
     ========================================================= */
  const guard = {
    status: 'off',          // off | loading | watching | error
    errorKind: null,        // blocked | denied | camera | model
    reason: 'focused',
    detail: '',
    enabled: false,
    sensitivity: 'balanced',
    centre: { yaw: 0, pitch: 0 },
    machine: newMachine(),

    landmarker: null,
    stream: null,
    video: null,
    loopId: null,
    lastSampleAt: 0,
    lastVideoTime: -1,
    calibrating: null,
    handlers: {}
  };

  function emit(name, payload) {
    const handler = guard.handlers[name];
    if (typeof handler === 'function') handler(payload);
  }

  /* `kind` separates "this environment cannot do it" from "you said no"
     from "the download failed" - the caller reacts differently to each. */
  function setStatus(status, detail, kind) {
    guard.status = status;
    guard.detail = detail || '';
    guard.errorKind = status === 'error' ? (kind || 'unknown') : null;
    emit('status', { status: status, detail: guard.detail, reason: guard.reason, kind: guard.errorKind });
  }

  function isSupported() {
    return Boolean(
      global.navigator && global.navigator.mediaDevices
      && global.navigator.mediaDevices.getUserMedia
      && global.WebAssembly
    );
  }

  /* file:// has no secure context for getUserMedia in most browsers, and
     the WASM fetch is cross-origin. Say so before asking for the camera. */
  function blockedReason() {
    if (global.location.protocol === 'file:') {
      return 'Open Focusline over http://localhost - browsers block the camera on file:// pages.';
    }
    if (!isSupported()) return 'This browser cannot run the attention guard.';
    return null;
  }

  async function loadModel() {
    if (guard.landmarker) return guard.landmarker;

    /* Dynamic import: nothing is fetched until the guard is switched on,
       so the rest of the app stays dependency-free and offline-capable. */
    const vision = await import(/* webpackIgnore: true */ TASKS_BUNDLE);
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_ROOT);

    function build(delegate) {
      return vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false
      });
    }

    try {
      guard.landmarker = await build('GPU');
    } catch (error) {
      /* No WebGL2 (remote desktops, blocklisted drivers, headless): the
         CPU delegate is slower but this only runs at ~7fps anyway. */
      guard.landmarker = await build('CPU');
    }
    return guard.landmarker;
  }

  /* Never block start-up on video.play(): its promise can reject under an
     autoplay policy, or simply never settle, while the stream itself is
     perfectly fine. Wait for real frames instead, and give up waiting
     rather than hanging - sample() re-checks readyState every tick. */
  function waitForFrames(video, timeoutMs) {
    return new Promise(function (resolve) {
      if (video.readyState >= 2 && video.videoWidth) {
        resolve(true);
        return;
      }
      let settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        video.removeEventListener('loadeddata', onData);
        global.clearTimeout(timer);
        resolve(ok);
      }
      function onData() { finish(true); }
      video.addEventListener('loadeddata', onData);
      const timer = global.setTimeout(function () { finish(false); }, timeoutMs || 5000);
    });
  }

  /* getUserMedia has half a dozen distinct failure modes and they need
     completely different fixes: a missing camera, a camera held by Teams,
     a browser permission, and an OS privacy switch are not the same
     problem. Collapsing them into "no camera could be opened" leaves the
     reader with nothing to do. */
  const CAMERA_ERRORS = {
    NotFoundError: {
      kind: 'nodevice',
      message: 'No camera is attached to this computer. Plug a webcam in, or leave the guard off.'
    },
    DevicesNotFoundError: {
      kind: 'nodevice',
      message: 'No camera is attached to this computer. Plug a webcam in, or leave the guard off.'
    },
    NotReadableError: {
      kind: 'busy',
      message: 'Your camera is already in use by another app. Close Teams, Zoom, OBS or the Camera app, then try again.'
    },
    TrackStartError: {
      kind: 'busy',
      message: 'Your camera is already in use by another app. Close Teams, Zoom, OBS or the Camera app, then try again.'
    },
    NotAllowedError: {
      kind: 'denied',
      message: 'Camera access was declined. Allow it from the padlock in the address bar, and check Windows Settings › Privacy › Camera.'
    },
    PermissionDeniedError: {
      kind: 'denied',
      message: 'Camera access was declined. Allow it from the padlock in the address bar, and check Windows Settings › Privacy › Camera.'
    },
    SecurityError: {
      kind: 'denied',
      message: 'The browser blocked camera access on this page. It must be served over https:// or http://localhost.'
    },
    TimeoutError: {
      kind: 'camera',
      message: 'The camera did not respond. It may be held by another app, or disabled in Windows Settings › Privacy › Camera.'
    },
    AbortError: {
      kind: 'camera',
      message: 'The camera was found but could not be started. This is usually a driver problem — try unplugging it, or reboot.'
    }
  };

  function isConstraintError(error) {
    return Boolean(error) && (error.name === 'OverconstrainedError'
      || error.name === 'ConstraintNotSatisfiedError');
  }

  function describeCameraError(error) {
    const name = (error && error.name) || 'UnknownError';
    const known = CAMERA_ERRORS[name];
    if (known) return { kind: known.kind, message: known.message + ' (' + name + ')' };
    return {
      kind: 'camera',
      message: 'The camera could not be opened (' + name + ').'
    };
  }

  /* Resolves with `fallback` if the promise takes too long. Device APIs
     can sit unresolved forever on some drivers and virtualised setups, and
     nothing here is worth hanging start-up over. */
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        global.setTimeout(function () { resolve(fallback); }, ms);
      })
    ]);
  }

  /* Counting video inputs answers "is there a camera at all" without
     asking for permission. Chromium lists devices with blank labels
     before consent, so the count is trustworthy even then.

     Returns null for "could not tell" - never confuse that with 0, which
     is a positive claim that the machine has no camera. */
  async function countCameras() {
    const media = global.navigator && global.navigator.mediaDevices;
    if (!media || !media.enumerateDevices) return null;
    try {
      const devices = await withTimeout(media.enumerateDevices(), DEVICE_QUERY_MS, null);
      if (!devices || typeof devices.filter !== 'function') return null;
      return devices.filter(function (device) { return device.kind === 'videoinput'; }).length;
    } catch (error) {
      return null;
    }
  }

  /* A report the settings panel can show on demand, so a failure can be
     understood without opening devtools. */
  async function diagnose() {
    const blocked = blockedReason();
    if (blocked) return { ok: false, kind: 'blocked', message: blocked };

    const cameras = await countCameras();
    if (cameras === 0) {
      return {
        ok: false,
        kind: 'nodevice',
        message: 'Windows reports no camera attached to this computer.'
      };
    }

    let stream = null;
    try {
      stream = await requestStream();
    } catch (error) {
      const described = describeCameraError(error);
      return { ok: false, kind: described.kind, message: described.message, cameras: cameras };
    }

    const track = stream.getVideoTracks()[0];
    const label = track && track.label ? track.label : 'camera';
    const settingsInfo = track && track.getSettings ? track.getSettings() : {};
    stream.getTracks().forEach(function (item) {
      try { item.stop(); } catch (error) { /* already stopped */ }
    });

    return {
      ok: true,
      kind: 'ok',
      cameras: cameras,
      message: 'Working: ' + label
        + (settingsInfo.width ? ' at ' + settingsInfo.width + '×' + settingsInfo.height : '')
        + '. The guard is ready.'
    };
  }

  /* Preferred constraints first; a camera that cannot meet them still
     works fine at whatever it does support. */
  const TIMED_OUT = { __timedOut: true };

  async function requestStream() {
    const media = global.navigator.mediaDevices;
    let stream;
    try {
      stream = await withTimeout(media.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
        audio: false
      }), CAMERA_OPEN_MS, TIMED_OUT);
    } catch (error) {
      if (!isConstraintError(error)) throw error;
      /* A camera that cannot meet the preferred size still works fine at
         whatever it does support. */
      stream = await withTimeout(media.getUserMedia({ video: true, audio: false }),
        CAMERA_OPEN_MS, TIMED_OUT);
    }
    if (stream === TIMED_OUT) {
      const error = new Error('camera open timed out');
      error.name = 'TimeoutError';
      throw error;
    }
    return stream;
  }

  async function openCamera(video) {
    const stream = await requestStream();
    guard.stream = stream;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;

    const playing = video.play();
    if (playing && typeof playing.catch === 'function') playing.catch(function () {});

    await waitForFrames(video);
    return stream;
  }

  async function start(options) {
    const settings = options || {};
    guard.video = settings.video || guard.video;
    guard.sensitivity = SENSITIVITY[settings.sensitivity] ? settings.sensitivity : 'balanced';
    if (settings.centre) guard.centre = { yaw: settings.centre.yaw || 0, pitch: settings.centre.pitch || 0 };

    const blocked = blockedReason();
    if (blocked) {
      setStatus('error', blocked, 'blocked');
      return false;
    }

    guard.enabled = true;
    setStatus('loading', 'Starting the camera…');

    /* Ask the OS before asking the user: if nothing is plugged in, say so
       plainly rather than surfacing a permission prompt that cannot help. */
    const cameras = await countCameras();
    if (cameras === 0) {
      guard.enabled = false;
      setStatus('error',
        'No camera is attached to this computer. Plug a webcam in, or leave the guard off.',
        'nodevice');
      return false;
    }

    try {
      await openCamera(guard.video);
    } catch (error) {
      guard.enabled = false;
      const described = describeCameraError(error);
      setStatus('error', described.message, described.kind);
      releaseCamera();
      return false;
    }

    try {
      setStatus('loading', 'Loading the model (about 3 MB, once)…');
      await loadModel();
    } catch (error) {
      guard.enabled = false;
      setStatus('error', 'The vision model could not be downloaded. Check your connection.', 'model');
      releaseCamera();
      return false;
    }

    if (!guard.enabled) {        // switched off while we were loading
      releaseCamera();
      return false;
    }

    guard.machine = newMachine();
    guard.lastSampleAt = 0;
    guard.lastVideoTime = -1;
    setStatus('watching', '');
    scheduleSample();
    return true;
  }

  function stop() {
    guard.enabled = false;
    if (guard.loopId) {
      global.clearTimeout(guard.loopId);
      guard.loopId = null;
    }
    guard.calibrating = null;
    guard.machine = newMachine();
    releaseCamera();
    setStatus('off', '');
  }

  function releaseCamera() {
    if (guard.stream) {
      guard.stream.getTracks().forEach(function (track) {
        try { track.stop(); } catch (error) { /* already stopped */ }
      });
      guard.stream = null;
    }
    if (guard.video) {
      try { guard.video.srcObject = null; } catch (error) { /* detached */ }
    }
  }

  /* A plain timeout loop rather than requestAnimationFrame: rAF stops
     dead in a background tab, which is exactly when a focus guard still
     has a job to do. Timers are throttled there but not silenced. */
  function scheduleSample() {
    if (!guard.enabled) return;
    guard.loopId = global.setTimeout(function () {
      sample();
      scheduleSample();
    }, SAMPLE_MS);
  }

  function sample() {
    if (!guard.enabled || !guard.landmarker || !guard.video) return;

    const video = guard.video;
    if (video.readyState < 2 || !video.videoWidth) return;

    const now = global.performance && global.performance.now
      ? global.performance.now() : Date.now();

    let result = null;
    try {
      /* detectForVideo insists on a monotonically increasing timestamp. */
      if (video.currentTime === guard.lastVideoTime) return;
      guard.lastVideoTime = video.currentTime;
      result = guard.landmarker.detectForVideo(video, now);
    } catch (error) {
      return;
    }

    const signals = readSignals(result);

    if (guard.calibrating) {
      collectCalibration(signals, now);
      return;
    }

    const dtMs = guard.lastSampleAt
      ? Math.min(MAX_STEP_MS, now - guard.lastSampleAt)
      : SAMPLE_MS;
    guard.lastSampleAt = now;

    const tuning = SENSITIVITY[guard.sensitivity];
    const verdict = judge(signals, tuning, guard.centre);
    const previousReason = guard.reason;
    guard.reason = verdict.reason;

    const transition = step(guard.machine, verdict.attentive, dtMs, tuning);

    emit('tick', {
      attentive: verdict.attentive,
      reason: verdict.reason,
      present: signals.present,
      pressure: Math.min(1, guard.machine.debt / tuning.graceMs),
      flagged: guard.machine.flagged
    });

    if (transition === 'lost') {
      emit('lost', { reason: verdict.reason, message: REASONS[verdict.reason] || REASONS.away });
    } else if (transition === 'regained') {
      emit('regained', {});
    } else if (previousReason !== verdict.reason) {
      emit('status', { status: guard.status, detail: guard.detail, reason: verdict.reason });
    }
  }

  /* =========================================================
     Calibration - everyone sits differently in front of a camera
     ========================================================= */
  function calibrate() {
    if (guard.status !== 'watching') return false;
    guard.calibrating = { until: 0, yaw: [], pitch: [], started: false };
    emit('calibrating', { active: true });
    return true;
  }

  function collectCalibration(signals, now) {
    const session = guard.calibrating;
    if (!session.started) {
      session.started = true;
      session.until = now + CALIBRATION_MS;
    }
    if (signals.present) {
      session.yaw.push(signals.yaw);
      session.pitch.push(signals.pitch);
    }
    if (now < session.until) return;

    guard.calibrating = null;
    if (session.yaw.length < 4) {
      emit('calibrating', { active: false, ok: false });
      return;
    }
    guard.centre = { yaw: median(session.yaw), pitch: median(session.pitch) };
    guard.machine = newMachine();
    guard.lastSampleAt = 0;
    emit('calibrating', { active: false, ok: true, centre: guard.centre });
  }

  function median(values) {
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function setSensitivity(name) {
    if (!SENSITIVITY[name]) return;
    guard.sensitivity = name;
    guard.machine = newMachine();
  }

  function setCentre(centre) {
    guard.centre = { yaw: (centre && centre.yaw) || 0, pitch: (centre && centre.pitch) || 0 };
  }

  function on(name, handler) {
    guard.handlers[name] = handler;
  }

  global.FocuslineVision = {
    start: start,
    stop: stop,
    calibrate: calibrate,
    setSensitivity: setSensitivity,
    setCentre: setCentre,
    on: on,
    isSupported: isSupported,
    blockedReason: blockedReason,
    diagnose: diagnose,
    countCameras: countCameras,
    getStatus: function () {
      return {
        status: guard.status, detail: guard.detail, reason: guard.reason,
        kind: guard.errorKind, centre: guard.centre
      };
    },
    REASONS: REASONS,
    SENSITIVITY: SENSITIVITY,

    /* Exposed so the scoring can be exercised without a camera. */
    _internals: {
      readSignals: readSignals,
      judge: judge,
      step: step,
      newMachine: newMachine,
      blendshapeMap: blendshapeMap,
      median: median
    }
  };
})(window);
