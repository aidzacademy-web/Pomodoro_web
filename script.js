'use strict';

/* =========================================================
   Focusline - pomodoro timer
   ========================================================= */

const STORAGE_KEY = 'focusline-state-v3';
const LEGACY_KEYS = ['focusline-state-v2', 'focusline-pomodoro-settings'];
const THEME_KEY = 'focusline-theme';
const TICK_MS = 250;

/* How the end-of-session alarm behaves. */
const ALARM_INTERVAL_MS = 4000;
const ALARM_MAX_REPEATS = 15;
const ALARM_PRESCHEDULE_S = 30;

const DEFAULT_SETTINGS = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoMode: true,
  soundOn: true,
  repeatAlarm: true,
  flashTab: true,
  notificationsOn: false,
  alarmSound: 'chime',
  volume: 0.7
};

const MODES = {
  work: { label: 'Focus session', caption: 'minutes remaining', ringClass: '', field: 'workMinutes' },
  break: { label: 'Short break', caption: 'time to reset', ringClass: 'break', field: 'breakMinutes' },
  long: { label: 'Long break', caption: 'time to step away', ringClass: 'long', field: 'longBreakMinutes' }
};

const CONTROLS = {
  work: { field: 'workMinutes', min: 1, max: 120, number: 'workDuration', range: 'workRange', mode: 'work' },
  break: { field: 'breakMinutes', min: 1, max: 60, number: 'breakDuration', range: 'breakRange', mode: 'break' },
  long: { field: 'longBreakMinutes', min: 1, max: 60, number: 'longBreakDuration', range: 'longBreakRange', mode: 'long' },
  rounds: { field: 'roundsBeforeLongBreak', min: 2, max: 8, number: 'roundsInput', range: 'roundsRange', mode: null }
};

/* Alarms are synthesised, so there is no audio file to ship or fail to load. */
const ALARM_SOUNDS = {
  chime: {
    type: 'sine',
    peak: 0.17,
    steps: [{ f: 523.25, t: 0, d: 0.55 }, { f: 659.25, t: 0.16, d: 0.55 }, { f: 783.99, t: 0.32, d: 0.85 }]
  },
  bell: {
    type: 'triangle',
    peak: 0.15,
    steps: [{ f: 880, t: 0, d: 1.1 }, { f: 1318.51, t: 0.01, d: 0.7 }, { f: 880, t: 0.62, d: 1.1 }]
  },
  alarm: {
    type: 'square',
    peak: 0.09,
    steps: [
      { f: 880, t: 0, d: 0.13 }, { f: 660, t: 0.18, d: 0.13 }, { f: 880, t: 0.36, d: 0.13 },
      { f: 660, t: 0.54, d: 0.13 }, { f: 880, t: 0.72, d: 0.26 }
    ]
  },
  rise: {
    type: 'sawtooth',
    peak: 0.08,
    steps: [{ f: 440, t: 0, d: 0.26 }, { f: 587.33, t: 0.2, d: 0.26 }, { f: 783.99, t: 0.4, d: 0.26 }, { f: 1046.5, t: 0.6, d: 0.55 }]
  }
};

const FAVICONS = {
  idle: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%232f6b5b' stroke-width='3'/%3E%3Cpath d='M16 9v7h5' fill='none' stroke='%232f6b5b' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",
  alert: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23e47b62'/%3E%3Cpath d='M16 8v8h5' fill='none' stroke='%23fffdf9' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E"
};

const ELEMENT_IDS = [
  'headerStatusText', 'themeToggle', 'themeLabel', 'favicon',
  'timerPanel', 'modePill', 'modeLabel', 'cycleNumber', 'fullscreenButton',
  'timerRing', 'progressRing', 'timeDisplay', 'timeCaption',
  'startButton', 'startIcon', 'startLabel', 'resetButton', 'skipButton', 'nextUp',
  'completedSessions', 'focusMinutes', 'sessionState', 'trackDots', 'trackCount', 'resetStats',
  'workDuration', 'workRange', 'breakDuration', 'breakRange',
  'longBreakDuration', 'longBreakRange', 'roundsInput', 'roundsRange',
  'autoToggle', 'autoLabel', 'soundToggle', 'soundLabel', 'repeatToggle', 'repeatLabel',
  'flashToggle', 'flashLabel', 'notifyToggle', 'notifyLabel', 'permissionStatus',
  'alarmSound', 'volumeRange', 'volumeValue', 'testAlert',
  'alertBar', 'alertTitle', 'alertBody', 'alertDismiss',
  'savedLabel', 'toast'
];

const elements = {};
ELEMENT_IDS.forEach(function (id) { elements[id] = document.getElementById(id); });

const settings = Object.assign({}, DEFAULT_SETTINGS);

const state = {
  mode: 'work',
  isRunning: false,
  cycle: 1,
  round: 0,
  endTime: null,
  remainingMs: DEFAULT_SETTINGS.workMinutes * 60 * 1000,
  stats: { date: todayKey(), completed: 0, focusMs: 0 },
  tickId: null,
  wakeLock: null
};

const alertState = {
  active: false,
  repeats: 0,
  repeatTimer: null,
  flashTimer: null,
  flashOn: false,
  flashTitle: ''
};

const rendered = {};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'auto';
let circumference = 0;
let audioContext = null;
let scheduledNodes = [];
let alarmPrescheduled = false;
let persistTimeout = null;
let savedTimeout = null;
let toastTimeout = null;
let sessionExpiredWhileAway = false;

init();

/* =========================================================
   Boot
   ========================================================= */
function init() {
  loadPersistedState();
  setupRing();
  syncControls();
  syncToggles();
  applyTheme(readStore(THEME_KEY) || 'auto');
  renderPermissionStatus();
  attachEvents();
  render();

  if (sessionExpiredWhileAway) {
    showToast('Your last session ran out while the tab was closed');
  }
}

function setupRing() {
  const radius = Number(elements.progressRing.getAttribute('r')) || 164;
  circumference = 2 * Math.PI * radius;
  elements.progressRing.style.strokeDasharray = String(circumference);
}

/* =========================================================
   Storage
   ========================================================= */
function readStore(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    /* Storage is optional: the timer still runs without it. */
  }
}

function readJSON(key) {
  const raw = readStore(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function persist() {
  writeStore(STORAGE_KEY, JSON.stringify({
    version: 3,
    settings: settings,
    stats: state.stats,
    session: {
      mode: state.mode,
      cycle: state.cycle,
      round: state.round,
      remainingMs: state.remainingMs,
      endTime: state.endTime,
      isRunning: state.isRunning
    }
  }));
}

function schedulePersist() {
  window.clearTimeout(persistTimeout);
  persistTimeout = window.setTimeout(persist, 300);
  flashSaved();
}

function flashSaved() {
  elements.savedLabel.textContent = 'Saved just now';
  window.clearTimeout(savedTimeout);
  savedTimeout = window.setTimeout(function () {
    elements.savedLabel.textContent = 'Saved automatically';
  }, 1800);
}

function loadPersistedState() {
  let saved = readJSON(STORAGE_KEY);
  if (!saved) {
    for (let index = 0; index < LEGACY_KEYS.length && !saved; index += 1) {
      const legacy = readJSON(LEGACY_KEYS[index]);
      if (legacy) saved = legacy.settings ? legacy : { settings: legacy };
    }
  }
  if (!saved) return;

  if (saved.settings) {
    Object.keys(CONTROLS).forEach(function (key) {
      const control = CONTROLS[key];
      settings[control.field] = clamp(saved.settings[control.field], control.min, control.max, DEFAULT_SETTINGS[control.field]);
    });
    settings.autoMode = saved.settings.autoMode !== false;
    settings.soundOn = saved.settings.soundOn !== false;
    settings.repeatAlarm = saved.settings.repeatAlarm !== false;
    settings.flashTab = saved.settings.flashTab !== false;
    settings.alarmSound = ALARM_SOUNDS[saved.settings.alarmSound] ? saved.settings.alarmSound : DEFAULT_SETTINGS.alarmSound;
    settings.volume = Number.isFinite(Number(saved.settings.volume))
      ? Math.min(1, Math.max(0, Number(saved.settings.volume)))
      : DEFAULT_SETTINGS.volume;
    settings.notificationsOn = saved.settings.notificationsOn === true
      && 'Notification' in window
      && Notification.permission === 'granted';
  }

  if (saved.stats && saved.stats.date === todayKey()) {
    state.stats.completed = Math.max(0, toInt(saved.stats.completed, 0));
    state.stats.focusMs = Math.max(0, toInt(saved.stats.focusMs, 0));
  }

  restoreSession(saved.session);
}

function restoreSession(session) {
  state.remainingMs = durationFor(state.mode);
  if (!session) return;

  if (MODES[session.mode]) state.mode = session.mode;
  state.cycle = Math.max(1, toInt(session.cycle, 1));
  state.round = clamp(session.round, 0, settings.roundsBeforeLongBreak, 0);

  const remaining = session.isRunning && Number.isFinite(session.endTime)
    ? session.endTime - Date.now()
    : toInt(session.remainingMs, 0);

  if (remaining > 1000) {
    /* A reloaded timer comes back paused: predictable beats clever. */
    state.remainingMs = Math.min(remaining, durationFor(state.mode));
  } else {
    state.remainingMs = durationFor(state.mode);
    sessionExpiredWhileAway = Boolean(session.isRunning);
  }
}

/* =========================================================
   Helpers
   ========================================================= */
function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback !== undefined ? fallback : min;
  return Math.min(max, Math.max(min, parsed));
}

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function todayKey() {
  const now = new Date();
  return now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
}

function durationFor(mode) {
  return settings[MODES[mode].field] * 60 * 1000;
}

function plural(minutes) {
  return minutes + ' minute' + (minutes > 1 ? 's' : '');
}

function ensureToday() {
  if (state.stats.date === todayKey()) return;
  state.stats = { date: todayKey(), completed: 0, focusMs: 0 };
}

/* =========================================================
   Timer
   ========================================================= */
function start() {
  if (state.isRunning) {
    pause();
    return;
  }
  if (state.remainingMs <= 0) state.remainingMs = durationFor(state.mode);

  state.isRunning = true;
  state.endTime = Date.now() + state.remainingMs;
  state.tickId = window.setInterval(tick, TICK_MS);

  unlockAudio();
  requestWakeLock();
  persist();
  render();
}

function pause() {
  if (!state.isRunning) return;
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  stopTicking();
  persist();
  render();
}

function stopTicking() {
  window.clearInterval(state.tickId);
  state.tickId = null;
  state.isRunning = false;
  state.endTime = null;
  cancelScheduledAlarm();
  releaseWakeLock();
}

function tick() {
  if (!state.isRunning) return;
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  prescheduleAlarm();
  render();
  if (state.remainingMs <= 0) completeSession(false);
}

function reset() {
  stopTicking();
  state.mode = 'work';
  state.cycle = 1;
  state.round = 0;
  state.remainingMs = durationFor('work');
  persist();
  render();
  showToast('Timer reset');
}

function skip() {
  if (state.isRunning) {
    state.remainingMs = Math.max(0, state.endTime - Date.now());
  }
  completeSession(true);
}

function completeSession(wasSkipped) {
  ensureToday();

  const finished = state.mode;
  const wasWork = finished === 'work';
  const elapsedMs = Math.max(0, durationFor(finished) - Math.max(0, state.remainingMs));

  window.clearInterval(state.tickId);
  state.tickId = null;
  state.isRunning = false;
  state.endTime = null;
  releaseWakeLock();

  if (wasWork) {
    /* Count the minutes actually spent, not sessions x current setting. */
    state.stats.focusMs += elapsedMs;
    if (!wasSkipped) state.stats.completed += 1;
  }

  if (wasWork) {
    const earnedLongBreak = !wasSkipped && state.round + 1 >= settings.roundsBeforeLongBreak;
    if (!wasSkipped) state.round += 1;
    state.mode = earnedLongBreak ? 'long' : 'break';
  } else {
    if (finished === 'long') state.round = 0;
    state.mode = 'work';
    state.cycle += 1;
  }

  state.remainingMs = durationFor(state.mode);
  persist();

  if (wasSkipped) {
    cancelScheduledAlarm();
    render();
    showToast(MODES[finished].label + ' skipped');
    return;
  }

  triggerAlert(
    wasWork ? 'Focus session complete' : 'Break complete',
    wasWork
      ? 'Time for ' + plural(settings[MODES[state.mode].field]) + ' away from the screen.'
      : 'Back to ' + plural(settings.workMinutes) + ' of focus.'
  );

  if (settings.autoMode) start();
  render();
}

/* =========================================================
   Alerts: sound, desktop notification, tab flash, banner
   ========================================================= */
function triggerAlert(title, body) {
  alertState.active = true;
  alertState.repeats = 0;

  elements.alertTitle.textContent = title;
  elements.alertBody.textContent = body;
  elements.alertBar.classList.add('show');

  ringAlarm();
  sendNotification(title, body);
  if (settings.flashTab) startTabFlash(title);
  render();
}

function clearAlert() {
  if (!alertState.active) return;
  alertState.active = false;
  stopRepeatingAlarm();
  stopTabFlash();
  elements.alertBar.classList.remove('show');
  render();
}

function ringAlarm() {
  if (!settings.soundOn) return;

  /* The alarm may already be sounding: it is queued 30s ahead of time so
     background-tab timer throttling can never make it late. */
  if (alarmPrescheduled) {
    alarmPrescheduled = false;
    scheduledNodes = [];
  } else if (!playAlarm()) {
    showToast('Sound is blocked until you interact with the page once');
    return;
  }

  if (!settings.repeatAlarm) return;

  stopRepeatingAlarm();
  alertState.repeatTimer = window.setInterval(function () {
    alertState.repeats += 1;
    if (!alertState.active || alertState.repeats >= ALARM_MAX_REPEATS) {
      stopRepeatingAlarm();
      return;
    }
    playAlarm();
  }, ALARM_INTERVAL_MS);
}

function stopRepeatingAlarm() {
  window.clearInterval(alertState.repeatTimer);
  alertState.repeatTimer = null;
  cancelScheduledAlarm();
}

function startTabFlash(message) {
  stopTabFlash();
  alertState.flashTitle = message;
  alertState.flashOn = true;
  paintTabFlash();
  alertState.flashTimer = window.setInterval(function () {
    alertState.flashOn = !alertState.flashOn;
    paintTabFlash();
  }, 900);
}

function paintTabFlash() {
  document.title = alertState.flashOn ? '\u23F0 ' + alertState.flashTitle : 'Focusline';
  if (elements.favicon) elements.favicon.href = alertState.flashOn ? FAVICONS.alert : FAVICONS.idle;
}

function stopTabFlash() {
  window.clearInterval(alertState.flashTimer);
  alertState.flashTimer = null;
  if (elements.favicon) elements.favicon.href = FAVICONS.idle;
  rendered.title = null;
}

/* =========================================================
   Audio
   ========================================================= */
function getAudioContext() {
  if (!audioContext) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      audioContext = new AudioCtor();
    } catch (error) {
      return null;
    }
  }
  if (audioContext.state === 'suspended') audioContext.resume().catch(function () {});
  return audioContext;
}

/* Browsers only allow audio after a gesture, so open the context on any click. */
function unlockAudio() {
  if (settings.soundOn) getAudioContext();
}

function playAlarm(startAt) {
  const context = getAudioContext();
  if (!context || settings.volume <= 0) return false;

  const preset = ALARM_SOUNDS[settings.alarmSound] || ALARM_SOUNDS.chime;
  const base = typeof startAt === 'number' ? startAt : context.currentTime + 0.02;
  const master = context.createGain();
  master.gain.value = Math.min(1, Math.max(0, settings.volume));
  master.connect(context.destination);

  const nodes = [];
  preset.steps.forEach(function (step) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = preset.type;
    oscillator.frequency.setValueAtTime(step.f, base + step.t);
    gain.gain.setValueAtTime(0.0001, base + step.t);
    gain.gain.exponentialRampToValueAtTime(preset.peak, base + step.t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, base + step.t + step.d);
    oscillator.connect(gain).connect(master);
    oscillator.start(base + step.t);
    oscillator.stop(base + step.t + step.d + 0.05);
    nodes.push(oscillator);
  });
  return nodes;
}

/* Hidden tabs get their timers throttled, so the last 30 seconds of a session
   are handed to the audio clock, which is not throttled. */
function prescheduleAlarm() {
  if (alarmPrescheduled || !settings.soundOn || !state.isRunning) return;
  if (!audioContext || audioContext.state !== 'running') return;

  const remainingSeconds = state.remainingMs / 1000;
  if (remainingSeconds > ALARM_PRESCHEDULE_S || remainingSeconds <= 0.1) return;

  const nodes = playAlarm(audioContext.currentTime + remainingSeconds);
  if (!nodes) return;
  scheduledNodes = nodes;
  alarmPrescheduled = true;
}

function cancelScheduledAlarm() {
  scheduledNodes.forEach(function (node) {
    try { node.stop(); } catch (error) { /* already stopped */ }
    try { node.disconnect(); } catch (error) { /* already detached */ }
  });
  scheduledNodes = [];
  alarmPrescheduled = false;
}

/* =========================================================
   Desktop notifications
   ========================================================= */
function sendNotification(title, body) {
  if (!settings.notificationsOn) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const notification = new Notification(title, {
      body: body,
      tag: 'focusline-session',
      icon: FAVICONS.alert,
      badge: FAVICONS.alert,
      requireInteraction: settings.repeatAlarm,
      silent: true
    });
    notification.onclick = function () {
      window.focus();
      notification.close();
      clearAlert();
    };
    window.setTimeout(function () { notification.close(); }, 30000);
  } catch (error) {
    /* Some browsers only allow notifications from a service worker. */
  }
}

async function toggleNotifications() {
  if (settings.notificationsOn) {
    settings.notificationsOn = false;
    syncToggles();
    renderPermissionStatus();
    schedulePersist();
    return;
  }

  if (location.protocol === 'file:') {
    showToast('Serve the page over http://localhost to use desktop notifications');
    renderPermissionStatus();
    return;
  }

  if (!('Notification' in window)) {
    showToast('This browser does not support desktop notifications');
    return;
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      permission = 'denied';
    }
  }

  renderPermissionStatus();

  if (permission !== 'granted') {
    showToast('Notifications are blocked - allow them from the padlock icon in the address bar');
    return;
  }

  settings.notificationsOn = true;
  syncToggles();
  schedulePersist();
  sendNotification('Notifications are on', 'This is what a finished session will look like.');
}

function renderPermissionStatus() {
  const element = elements.permissionStatus;
  element.classList.remove('warn', 'ok');

  if (location.protocol === 'file:') {
    element.textContent = 'Open the page from a local server (http://localhost) - browsers block notifications on file:// pages.';
    element.classList.add('warn');
    return;
  }
  if (!('Notification' in window)) {
    element.textContent = 'This browser has no notification support.';
    element.classList.add('warn');
    return;
  }
  if (Notification.permission === 'granted') {
    element.textContent = 'Allowed by the browser. Check that Windows Focus Assist is off.';
    element.classList.add('ok');
    return;
  }
  if (Notification.permission === 'denied') {
    element.textContent = 'Blocked. Allow notifications from the padlock icon in the address bar.';
    element.classList.add('warn');
    return;
  }
  element.textContent = 'Not requested yet. Turn the switch on to ask the browser.';
}

/* =========================================================
   Screen wake lock
   ========================================================= */
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', function () { state.wakeLock = null; });
  } catch (error) {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  const lock = state.wakeLock;
  state.wakeLock = null;
  if (typeof lock.release === 'function') lock.release().catch(function () {});
}

/* =========================================================
   Rendering - writes only what actually changed
   ========================================================= */
function setText(key, element, value) {
  if (rendered[key] === value) return;
  rendered[key] = value;
  element.textContent = value;
}

function render() {
  const mode = MODES[state.mode];
  const total = durationFor(state.mode);
  const remaining = Math.max(0, state.remainingMs);
  const totalSeconds = Math.ceil(remaining / 1000);
  const clock = String(Math.floor(totalSeconds / 60)).padStart(2, '0') + ':' + String(totalSeconds % 60).padStart(2, '0');
  const progress = total > 0 ? remaining / total : 0;

  setText('clock', elements.timeDisplay, clock);
  setText('caption', elements.timeCaption, mode.caption);
  setText('mode', elements.modeLabel, mode.label);
  setText('cycle', elements.cycleNumber, String(state.cycle).padStart(2, '0'));

  elements.modePill.className = 'mode-pill' + (mode.ringClass ? ' ' + mode.ringClass : '');
  elements.timerRing.className = 'timer-ring'
    + (mode.ringClass ? ' ' + mode.ringClass : '')
    + (alertState.active ? ' alerting' : '');
  elements.progressRing.style.strokeDashoffset = String(circumference * (1 - progress));

  setText('startLabel', elements.startLabel, state.isRunning ? 'Pause' : startVerb());
  setText('startIcon', elements.startIcon, state.isRunning ? '\u2759\u2759' : '\u25B6');
  elements.startButton.setAttribute('aria-pressed', String(state.isRunning));

  setText('headerStatus', elements.headerStatusText, headerStatus());
  setText('sessionState', elements.sessionState, state.isRunning ? 'Active' : 'Ready');
  setText('completed', elements.completedSessions, String(state.stats.completed));
  setText('focus', elements.focusMinutes, String(Math.round(state.stats.focusMs / 60000)));
  setText('nextUp', elements.nextUp, 'Next: ' + nextSessionLabel());

  renderTrack();
  renderTitle(clock, mode.label);
}

function startVerb() {
  if (state.mode === 'work') return 'Start focus';
  return state.remainingMs < durationFor(state.mode) ? 'Resume break' : 'Start break';
}

function headerStatus() {
  if (alertState.active) return 'Session finished';
  if (!state.isRunning) return 'Ready to focus';
  return state.mode === 'work' ? 'Focus in progress' : 'Rest in progress';
}

function nextSessionLabel() {
  if (state.mode !== 'work') return plural(settings.workMinutes) + ' of focus';
  const earnsLongBreak = state.round + 1 >= settings.roundsBeforeLongBreak;
  return earnsLongBreak
    ? 'a long break of ' + plural(settings.longBreakMinutes)
    : 'a break of ' + plural(settings.breakMinutes);
}

function renderTrack() {
  const total = settings.roundsBeforeLongBreak;
  const done = Math.min(state.round, total);
  const signature = done + ' / ' + total;
  if (rendered.track === signature) return;
  rendered.track = signature;

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < total; index += 1) {
    const dot = document.createElement('span');
    dot.className = 'track-dot' + (index < done ? ' complete' : '');
    fragment.append(dot);
  }
  elements.trackDots.replaceChildren(fragment);
  elements.trackCount.textContent = signature;
}

function renderTitle(clock, label) {
  if (alertState.flashTimer) return; // the flashing alert owns the title
  const title = state.isRunning ? clock + ' \u00B7 ' + label : 'Focusline | Pomodoro Timer';
  if (rendered.title === title) return;
  rendered.title = title;
  document.title = title;
}

/* =========================================================
   Settings controls
   ========================================================= */
function syncControls() {
  Object.keys(CONTROLS).forEach(function (key) {
    const control = CONTROLS[key];
    elements[control.number].value = settings[control.field];
    elements[control.range].value = settings[control.field];
  });
  elements.alarmSound.value = settings.alarmSound;
  elements.volumeRange.value = Math.round(settings.volume * 100);
  elements.volumeValue.textContent = Math.round(settings.volume * 100) + '%';
}

function syncToggles() {
  setToggle(elements.autoToggle, elements.autoLabel, settings.autoMode);
  setToggle(elements.soundToggle, elements.soundLabel, settings.soundOn);
  setToggle(elements.repeatToggle, elements.repeatLabel, settings.repeatAlarm);
  setToggle(elements.flashToggle, elements.flashLabel, settings.flashTab);
  setToggle(elements.notifyToggle, elements.notifyLabel, settings.notificationsOn);
}

function setToggle(button, label, isOn) {
  button.setAttribute('aria-checked', String(isOn));
  label.textContent = isOn ? 'On' : 'Off';
}

function handleControlInput(key, rawValue, commit) {
  const control = CONTROLS[key];
  const raw = String(rawValue).trim();

  /* While typing, let the field be empty or half-written. */
  if (!commit && raw === '') return;
  const parsed = Number.parseInt(raw, 10);
  if (!commit && !Number.isFinite(parsed)) return;

  applySetting(key, clamp(parsed, control.min, control.max, settings[control.field]), commit);
}

function applySetting(key, value, syncNumberField) {
  const control = CONTROLS[key];
  settings[control.field] = value;
  elements[control.range].value = value;
  if (syncNumberField) elements[control.number].value = value;

  /* Only the mode you are currently sitting in gets its clock rewritten. */
  if (control.mode && control.mode === state.mode && !state.isRunning) {
    state.remainingMs = durationFor(state.mode);
    cancelScheduledAlarm();
  }
  if (key === 'rounds') state.round = Math.min(state.round, value);

  schedulePersist();
  render();
}

function clearStats() {
  state.stats = { date: todayKey(), completed: 0, focusMs: 0 };
  state.round = 0;
  state.cycle = 1;
  persist();
  render();
  showToast('Today\u2019s record cleared');
}

/* =========================================================
   Theme
   ========================================================= */
function applyTheme(preference) {
  themePreference = ['auto', 'light', 'dark'].indexOf(preference) >= 0 ? preference : 'auto';
  const dark = themePreference === 'dark' || (themePreference === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  elements.themeLabel.textContent = themePreference;
  writeStore(THEME_KEY, themePreference);
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  applyTheme(order[(order.indexOf(themePreference) + 1) % order.length]);
}

/* =========================================================
   Full screen
   ========================================================= */
async function toggleFullscreen() {
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  const panel = elements.timerPanel;

  try {
    if (active) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (panel.requestFullscreen) await panel.requestFullscreen();
    else if (panel.webkitRequestFullscreen) panel.webkitRequestFullscreen();
    else showToast('Full screen is not available in this browser');
  } catch (error) {
    showToast('Full screen could not be opened');
  }
}

function updateFullscreenControl() {
  const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  elements.fullscreenButton.textContent = active ? 'Exit full screen' : 'Full screen';
  elements.fullscreenButton.setAttribute('aria-label', active ? 'Exit full screen' : 'Enter full screen');
}

/* =========================================================
   Toast
   ========================================================= */
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(function () { elements.toast.classList.remove('show'); }, 2600);
}

/* =========================================================
   Events
   ========================================================= */
function attachEvents() {
  elements.startButton.addEventListener('click', function () { clearAlert(); start(); });
  elements.resetButton.addEventListener('click', function () { clearAlert(); reset(); });
  elements.skipButton.addEventListener('click', function () { clearAlert(); skip(); });
  elements.alertDismiss.addEventListener('click', clearAlert);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  elements.themeToggle.addEventListener('click', cycleTheme);
  elements.resetStats.addEventListener('click', clearStats);

  elements.testAlert.addEventListener('click', function () {
    unlockAudio();
    triggerAlert('Test alert', 'This is how Focusline will tell you a session is over.');
  });

  elements.autoToggle.addEventListener('click', function () {
    settings.autoMode = !settings.autoMode;
    syncToggles();
    schedulePersist();
    showToast(settings.autoMode ? 'Sessions continue automatically' : 'Each session waits for you');
  });

  elements.soundToggle.addEventListener('click', function () {
    settings.soundOn = !settings.soundOn;
    syncToggles();
    schedulePersist();
    if (settings.soundOn) {
      unlockAudio();
      playAlarm();
    } else {
      cancelScheduledAlarm();
      stopRepeatingAlarm();
    }
  });

  elements.repeatToggle.addEventListener('click', function () {
    settings.repeatAlarm = !settings.repeatAlarm;
    syncToggles();
    schedulePersist();
    if (!settings.repeatAlarm) stopRepeatingAlarm();
  });

  elements.flashToggle.addEventListener('click', function () {
    settings.flashTab = !settings.flashTab;
    syncToggles();
    schedulePersist();
    if (!settings.flashTab) stopTabFlash();
  });

  elements.notifyToggle.addEventListener('click', toggleNotifications);

  elements.alarmSound.addEventListener('change', function () {
    settings.alarmSound = ALARM_SOUNDS[elements.alarmSound.value] ? elements.alarmSound.value : 'chime';
    schedulePersist();
    unlockAudio();
    playAlarm();
  });

  elements.volumeRange.addEventListener('input', function () {
    settings.volume = clamp(elements.volumeRange.value, 0, 100, 70) / 100;
    elements.volumeValue.textContent = Math.round(settings.volume * 100) + '%';
    schedulePersist();
  });

  elements.volumeRange.addEventListener('change', function () {
    unlockAudio();
    playAlarm();
  });

  Object.keys(CONTROLS).forEach(function (key) {
    const control = CONTROLS[key];
    const numberField = elements[control.number];
    const rangeField = elements[control.range];
    numberField.addEventListener('input', function () { handleControlInput(key, numberField.value, false); });
    numberField.addEventListener('change', function () { handleControlInput(key, numberField.value, true); });
    numberField.addEventListener('blur', function () { handleControlInput(key, numberField.value, true); });
    rangeField.addEventListener('input', function () { handleControlInput(key, rangeField.value, true); });
  });

  /* Any interaction silences a ringing alarm. */
  document.addEventListener('pointerdown', function () {
    unlockAudio();
    clearAlert();
  });

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('fullscreenchange', updateFullscreenControl);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControl);

  darkQuery.addEventListener('change', function () {
    if (themePreference === 'auto') applyTheme('auto');
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') {
      persist();
      return;
    }
    ensureToday();
    if (state.isRunning) {
      requestWakeLock();
      tick();
    }
    render();
  });

  window.addEventListener('beforeunload', persist);
  window.addEventListener('pagehide', persist);
}

function onKeydown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const target = event.target;
  const tag = target && target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;

  /* The first key after an alarm just silences it. */
  if (alertState.active) {
    if (event.code === 'Space') event.preventDefault();
    clearAlert();
    return;
  }

  switch (event.code) {
    case 'Space':
      if (tag === 'BUTTON') return; // let the focused button handle its own key
      event.preventDefault();
      start();
      break;
    case 'KeyR':
      reset();
      break;
    case 'KeyS':
      skip();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    default:
      break;
  }
}
