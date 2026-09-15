'use strict';

/* =========================================================
   Focusline — pomodoro timer
   ========================================================= */

const STORAGE_KEY = 'focusline-state-v2';
const LEGACY_KEY = 'focusline-pomodoro-settings';
const THEME_KEY = 'focusline-theme';
const TICK_MS = 250;

const DEFAULT_SETTINGS = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  autoMode: true,
  soundOn: true,
  notificationsOn: false
};

const MODES = {
  work: { label: 'Focus session', caption: 'minutes remaining', ringClass: '', field: 'workMinutes' },
  break: { label: 'Short break', caption: 'time to reset', ringClass: 'break', field: 'breakMinutes' },
  long: { label: 'Long break', caption: 'time to step away', ringClass: 'long', field: 'longBreakMinutes' }
};

/* Each duration control pairs a number field with a slider. */
const CONTROLS = {
  work: { field: 'workMinutes', min: 1, max: 120, number: 'workDuration', range: 'workRange', mode: 'work' },
  break: { field: 'breakMinutes', min: 1, max: 60, number: 'breakDuration', range: 'breakRange', mode: 'break' },
  long: { field: 'longBreakMinutes', min: 1, max: 60, number: 'longBreakDuration', range: 'longBreakRange', mode: 'long' },
  rounds: { field: 'roundsBeforeLongBreak', min: 2, max: 8, number: 'roundsInput', range: 'roundsRange', mode: null }
};

const ELEMENT_IDS = [
  'headerStatusText', 'themeToggle', 'themeLabel',
  'timerPanel', 'modePill', 'modeLabel', 'cycleNumber', 'fullscreenButton',
  'timerRing', 'progressRing', 'timeDisplay', 'timeCaption',
  'startButton', 'startIcon', 'startLabel', 'resetButton', 'skipButton', 'nextUp',
  'completedSessions', 'focusMinutes', 'sessionState', 'trackDots', 'trackCount', 'resetStats',
  'workDuration', 'workRange', 'breakDuration', 'breakRange',
  'longBreakDuration', 'longBreakRange', 'roundsInput', 'roundsRange',
  'autoToggle', 'autoLabel', 'soundToggle', 'soundLabel', 'notifyToggle', 'notifyLabel',
  'savedLabel', 'toast'
];

const elements = {};
ELEMENT_IDS.forEach((id) => { elements[id] = document.getElementById(id); });

const settings = { ...DEFAULT_SETTINGS };

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

const rendered = {};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'auto';
let circumference = 0;
let audioContext = null;
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
   Storage — every call is guarded so private mode or a
   sandboxed iframe can never break the timer itself.
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
    /* Storage is optional. */
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
    version: 2,
    settings,
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
  savedTimeout = window.setTimeout(() => {
    elements.savedLabel.textContent = 'Saved automatically';
  }, 1800);
}

function loadPersistedState() {
  const saved = readJSON(STORAGE_KEY) || migrateLegacyState();
  if (!saved) return;

  if (saved.settings) {
    Object.entries(CONTROLS).forEach(([, control]) => {
      settings[control.field] = clamp(saved.settings[control.field], control.min, control.max, DEFAULT_SETTINGS[control.field]);
    });
    settings.autoMode = saved.settings.autoMode !== false;
    settings.soundOn = saved.settings.soundOn !== false;
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

function migrateLegacyState() {
  const legacy = readJSON(LEGACY_KEY);
  if (!legacy) return null;
  return {
    settings: {
      workMinutes: legacy.workMinutes,
      breakMinutes: legacy.breakMinutes,
      autoMode: legacy.autoMode
    }
  };
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
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function durationFor(mode) {
  return settings[MODES[mode].field] * 60 * 1000;
}

function plural(minutes) {
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

/* Stats belong to a day, so roll them over when the day does. */
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
  releaseWakeLock();
}

function tick() {
  if (!state.isRunning) return;
  state.remainingMs = Math.max(0, state.endTime - Date.now());
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

  stopTicking();

  if (wasWork) {
    /* Count the minutes actually spent, not minutes × current setting. */
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
  render();

  if (wasSkipped) {
    showToast(`${MODES[finished].label} skipped`);
  } else {
    playChime(wasWork);
    sendNotification(
      wasWork ? 'Focus session complete' : 'Break complete',
      wasWork ? `Time for ${plural(settings[MODES[state.mode].field])} away from the screen.` : 'Ready to focus again?'
    );
    showToast(wasWork ? 'Focus session complete' : 'Break complete');
    if (settings.autoMode) start();
  }
}

/* =========================================================
   Rendering — writes only what actually changed.
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
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const clock = `${minutes}:${seconds}`;
  const progress = total > 0 ? remaining / total : 0;

  setText('clock', elements.timeDisplay, clock);
  setText('caption', elements.timeCaption, mode.caption);
  setText('mode', elements.modeLabel, mode.label);
  setText('cycle', elements.cycleNumber, String(state.cycle).padStart(2, '0'));

  elements.modePill.className = `mode-pill${mode.ringClass ? ` ${mode.ringClass}` : ''}`;
  elements.timerRing.className = `timer-ring${mode.ringClass ? ` ${mode.ringClass}` : ''}`;
  elements.progressRing.style.strokeDashoffset = String(circumference * (1 - progress));

  setText('startLabel', elements.startLabel, state.isRunning ? 'Pause' : startVerb());
  setText('startIcon', elements.startIcon, state.isRunning ? '❚❚' : '▶');
  elements.startButton.setAttribute('aria-pressed', String(state.isRunning));

  setText('headerStatus', elements.headerStatusText, headerStatus());
  setText('sessionState', elements.sessionState, state.isRunning ? 'Active' : 'Ready');
  setText('completed', elements.completedSessions, String(state.stats.completed));
  setText('focus', elements.focusMinutes, String(Math.round(state.stats.focusMs / 60000)));
  setText('nextUp', elements.nextUp, `Next: ${nextSessionLabel()}`);

  renderTrack();
  renderTitle(clock, mode.label);
}

function startVerb() {
  if (state.mode === 'work') return 'Start focus';
  return state.remainingMs < durationFor(state.mode) ? 'Resume break' : 'Start break';
}

function headerStatus() {
  if (!state.isRunning) return 'Ready to focus';
  return state.mode === 'work' ? 'Focus in progress' : 'Rest in progress';
}

function nextSessionLabel() {
  if (state.mode !== 'work') return `${plural(settings.workMinutes)} of focus`;
  const earnsLongBreak = state.round + 1 >= settings.roundsBeforeLongBreak;
  return earnsLongBreak
    ? `a long break of ${plural(settings.longBreakMinutes)}`
    : `a break of ${plural(settings.breakMinutes)}`;
}

function renderTrack() {
  const total = settings.roundsBeforeLongBreak;
  const done = Math.min(state.round, total);
  const signature = `${done}/${total}`;
  if (rendered.track === signature) return;
  rendered.track = signature;

  const fragment = document.createDocumentFragment();
  for (let index = 0; index < total; index += 1) {
    const dot = document.createElement('span');
    dot.className = `track-dot${index < done ? ' complete' : ''}`;
    fragment.append(dot);
  }
  elements.trackDots.replaceChildren(fragment);
  elements.trackCount.textContent = signature;
}

function renderTitle(clock, label) {
  const title = state.isRunning ? `${clock} · ${label}` : 'Focusline | Pomodoro Timer';
  if (rendered.title === title) return;
  rendered.title = title;
  document.title = title;
}

/* =========================================================
   Settings controls
   ========================================================= */
function syncControls() {
  Object.values(CONTROLS).forEach((control) => {
    elements[control.number].value = settings[control.field];
    elements[control.range].value = settings[control.field];
  });
}

function syncToggles() {
  setToggle(elements.autoToggle, elements.autoLabel, settings.autoMode);
  setToggle(elements.soundToggle, elements.soundLabel, settings.soundOn);
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
  showToast('Today’s record cleared');
}

/* =========================================================
   Theme
   ========================================================= */
function applyTheme(preference) {
  themePreference = ['auto', 'light', 'dark'].includes(preference) ? preference : 'auto';
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
   Sound, notifications, screen wake lock
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
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}

/* Browsers only allow audio after a gesture, so open the context on click. */
function unlockAudio() {
  if (settings.soundOn) getAudioContext();
}

function playChime(wasWork) {
  if (!settings.soundOn) return;
  const context = getAudioContext();
  if (!context) return;

  const now = context.currentTime;
  const notes = wasWork ? [523.25, 659.25, 783.99] : [659.25, 523.25];

  notes.forEach((frequency, index) => {
    const delay = index * 0.17;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now + delay);
    gain.gain.setValueAtTime(0.0001, now + delay);
    gain.gain.exponentialRampToValueAtTime(0.09, now + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.34);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now + delay);
    oscillator.stop(now + delay + 0.38);
  });
}

function sendNotification(title, body) {
  if (!settings.notificationsOn) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'focusline-session', silent: true });
  } catch (error) {
    /* Some browsers only allow notifications from a service worker. */
  }
}

async function toggleNotifications() {
  if (settings.notificationsOn) {
    settings.notificationsOn = false;
    syncToggles();
    schedulePersist();
    showToast('Desktop alerts off');
    return;
  }

  if (!('Notification' in window)) {
    showToast('This browser does not support desktop alerts');
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

  if (permission !== 'granted') {
    showToast('Alerts are blocked — allow notifications in your browser settings');
    return;
  }

  settings.notificationsOn = true;
  syncToggles();
  schedulePersist();
  showToast('Desktop alerts on');
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (error) {
    state.wakeLock = null;
  }
}

function releaseWakeLock() {
  if (!state.wakeLock) return;
  const lock = state.wakeLock;
  state.wakeLock = null;
  if (typeof lock.release === 'function') lock.release().catch(() => {});
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
  toastTimeout = window.setTimeout(() => elements.toast.classList.remove('show'), 2400);
}

/* =========================================================
   Events
   ========================================================= */
function attachEvents() {
  elements.startButton.addEventListener('click', start);
  elements.resetButton.addEventListener('click', reset);
  elements.skipButton.addEventListener('click', skip);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  elements.themeToggle.addEventListener('click', cycleTheme);
  elements.resetStats.addEventListener('click', clearStats);

  elements.autoToggle.addEventListener('click', () => {
    settings.autoMode = !settings.autoMode;
    syncToggles();
    schedulePersist();
    showToast(settings.autoMode ? 'Sessions continue automatically' : 'Each session waits for you');
  });

  elements.soundToggle.addEventListener('click', () => {
    settings.soundOn = !settings.soundOn;
    syncToggles();
    schedulePersist();
    if (settings.soundOn) {
      unlockAudio();
      playChime(true);
    }
  });

  elements.notifyToggle.addEventListener('click', toggleNotifications);

  Object.entries(CONTROLS).forEach(([key, control]) => {
    const numberField = elements[control.number];
    const rangeField = elements[control.range];
    numberField.addEventListener('input', () => handleControlInput(key, numberField.value, false));
    numberField.addEventListener('change', () => handleControlInput(key, numberField.value, true));
    numberField.addEventListener('blur', () => handleControlInput(key, numberField.value, true));
    rangeField.addEventListener('input', () => handleControlInput(key, rangeField.value, true));
  });

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('fullscreenchange', updateFullscreenControl);
  document.addEventListener('webkitfullscreenchange', updateFullscreenControl);

  darkQuery.addEventListener('change', () => {
    if (themePreference === 'auto') applyTheme('auto');
  });

  document.addEventListener('visibilitychange', () => {
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
