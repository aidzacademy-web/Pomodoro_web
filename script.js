'use strict';

/* =========================================================
   Focusline - a pomodoro timer for deep work

   Layout of this file:
     1. Constants          6. Tasks
     2. Storage            7. Alerts, audio, notifications
     3. Helpers            8. Rendering (timer view)
     4. History            9. Insights (stats + charts)
     5. Timer             10. Events
   ========================================================= */

const STORAGE_KEY = 'focusline-state-v4';
const LEGACY_KEYS = ['focusline-state-v3', 'focusline-state-v2', 'focusline-pomodoro-settings'];
const THEME_KEY = 'focusline-theme';
const TICK_MS = 250;

/* How the end-of-session alarm behaves. */
const ALARM_INTERVAL_MS = 4000;
const ALARM_MAX_REPEATS = 15;
const ALARM_PRESCHEDULE_S = 30;

/* One drift is one distraction: the guard cannot log again until this
   has passed, however long you stay away. */
const AUTO_FLAG_COOLDOWN_MS = 45 * 1000;

/* How long the camera stays up after you switch the guard on, so the
   preview is live long enough to see yourself and calibrate. */
const GUARD_PREVIEW_MS = 45 * 1000;

const GUARD_PATIENCE = {
  relaxed: 'Counts a distraction after about 25 seconds away.',
  balanced: 'Counts a distraction after about 12 seconds away.',
  strict: 'Counts a distraction after about 6 seconds away.'
};

/* A session shorter than this is treated as a false start and not recorded. */
const MIN_RECORDED_MS = 30 * 1000;
const HISTORY_LIMIT = 5000;

const DEFAULT_SETTINGS = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  roundsBeforeLongBreak: 4,
  dailyGoalMinutes: 120,
  autoMode: true,
  strictMode: false,
  soundOn: true,
  repeatAlarm: true,
  flashTab: true,
  notificationsOn: false,
  alarmSound: 'chime',
  volume: 0.7,
  ambientSound: 'none',
  ambientVolume: 0.35,
  guardOn: false,
  guardNotify: true,
  guardSensitivity: 'balanced',
  guardYaw: 0,
  guardPitch: 0
};

const MODES = {
  work: { label: 'Focus session', caption: 'minutes remaining', ringClass: '', field: 'workMinutes' },
  break: { label: 'Short break', caption: 'time to reset', ringClass: 'break', field: 'breakMinutes' },
  long: { label: 'Long break', caption: 'time to step away', ringClass: 'long', field: 'longBreakMinutes' }
};

const CONTROLS = {
  work: { field: 'workMinutes', min: 1, max: 180, number: 'workDuration', range: 'workRange', mode: 'work' },
  break: { field: 'breakMinutes', min: 1, max: 60, number: 'breakDuration', range: 'breakRange', mode: 'break' },
  long: { field: 'longBreakMinutes', min: 1, max: 60, number: 'longBreakDuration', range: 'longBreakRange', mode: 'long' },
  rounds: { field: 'roundsBeforeLongBreak', min: 2, max: 8, number: 'roundsInput', range: 'roundsRange', mode: null },
  goal: { field: 'dailyGoalMinutes', min: 15, max: 720, number: 'goalInput', range: 'goalRange', mode: null }
};

const PRESETS = {
  classic: { workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, roundsBeforeLongBreak: 4 },
  deep: { workMinutes: 50, breakMinutes: 10, longBreakMinutes: 25, roundsBeforeLongBreak: 3 },
  ultradian: { workMinutes: 90, breakMinutes: 20, longBreakMinutes: 30, roundsBeforeLongBreak: 2 }
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

/* Each soundscape is a noise colour plus a filter shape. */
const AMBIENCES = {
  brown: { noise: 'brown', filter: { type: 'lowpass', frequency: 1200, Q: 0.7 }, gain: 0.55 },
  pink: { noise: 'pink', filter: { type: 'lowpass', frequency: 3200, Q: 0.6 }, gain: 0.35 },
  rain: { noise: 'white', filter: { type: 'bandpass', frequency: 1400, Q: 0.6 }, gain: 0.5, shimmer: 0.35 },
  waves: { noise: 'brown', filter: { type: 'lowpass', frequency: 700, Q: 0.9 }, gain: 0.7, swell: 0.09 },
  cafe: { noise: 'pink', filter: { type: 'lowpass', frequency: 420, Q: 1.1 }, gain: 0.8, swell: 0.22 }
};

/* Categorical slots, in fixed order, for the project split. Assigned by
   entity so a filter can never repaint the survivors. */
const SERIES_SLOTS = 6;

const FAVICONS = {
  idle: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='none' stroke='%232f6b5b' stroke-width='3'/%3E%3Cpath d='M16 9v7h5' fill='none' stroke='%232f6b5b' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",
  alert: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%23e47b62'/%3E%3Cpath d='M16 8v8h5' fill='none' stroke='%23fffdf9' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E"
};

const ELEMENT_IDS = [
  'headerStatusText', 'themeToggle', 'themeLabel', 'favicon',
  'tabTimer', 'tabInsights', 'viewTimer', 'viewInsights',
  'timerPanel', 'modePill', 'modeLabel', 'cycleNumber', 'fullscreenButton',
  'nowWorking', 'activeTaskButton', 'activeTaskDot', 'activeTaskName',
  'timerRing', 'progressRing', 'timeDisplay', 'timeCaption',
  'startButton', 'startIcon', 'startLabel', 'resetButton', 'skipButton',
  'distractionRow', 'distractionButton', 'distractionCount', 'nextUp',
  'todayFocus', 'goalTarget', 'goalMeter', 'goalFill', 'goalCaption',
  'completedSessions', 'streakValue', 'todayDistractions', 'trackDots', 'trackCount', 'resetStats',
  'taskForm', 'taskTitle', 'taskProject', 'taskEstimate', 'projectList', 'taskList', 'taskEmpty', 'clearDoneTasks',
  'workDuration', 'workRange', 'breakDuration', 'breakRange',
  'longBreakDuration', 'longBreakRange', 'roundsInput', 'roundsRange', 'goalInput', 'goalRange',
  'autoToggle', 'autoLabel', 'strictToggle', 'strictLabel',
  'ambientSound', 'ambientVolume', 'ambientVolumeValue', 'ambientPreview',
  'guardToggle', 'guardLabel', 'guardNotifyToggle', 'guardNotifyLabel', 'guardStatus',
  'guardSensitivity', 'guardPatienceNote', 'guardPreview', 'guardVideo', 'guardPreviewIdle',
  'guardLive', 'guardMeter', 'guardMeterFill', 'guardCalibrate', 'guardCheck',
  'guardChip', 'guardDot', 'guardChipText',
  'soundToggle', 'soundLabel', 'repeatToggle', 'repeatLabel',
  'flashToggle', 'flashLabel', 'notifyToggle', 'notifyLabel', 'permissionStatus',
  'alarmSound', 'volumeRange', 'volumeValue', 'testAlert',
  'alertBar', 'alertTitle', 'alertBody', 'alertDismiss',
  'savedLabel', 'toast',
  'heroValue', 'heroDelta',
  'kpiSessions', 'kpiSessionsDelta', 'kpiAverage', 'kpiAverageDelta',
  'kpiDaily', 'kpiDailySpark', 'kpiStreak', 'kpiStreakDetail',
  'kpiCompletion', 'kpiCompletionDetail', 'kpiDistraction', 'kpiDistractionDetail',
  'chartTrend', 'chartCalendar', 'chartHours', 'chartWeekdays', 'chartProjects', 'chartFocusQuality',
  'dataSummary', 'exportJson', 'exportCsv', 'importButton', 'importInput', 'wipeData'
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
  startedAt: null,
  distractions: 0,
  autoFlagged: 0,
  activeTaskId: null,
  tickId: null,
  wakeLock: null
};

let history = [];
let tasks = [];
let projectSlots = {};
let dayIndexCache = null;

const Vision = window.FocuslineVision || null;
const guardView = { status: 'off', reason: 'focused', pressure: 0, previewUntil: 0, holdTimer: null };
let lastAutoFlagAt = 0;

const alertState = {
  active: false,
  repeats: 0,
  repeatTimer: null,
  flashTimer: null,
  flashOn: false,
  flashTitle: ''
};

const ambient = { source: null, gain: null, filter: null, lfo: null, lfoGain: null, previewTimer: null };

const rendered = {};
const charts = {};
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const Viz = window.FocuslineCharts;

let themePreference = 'auto';
let currentView = 'timer';
let insightsRange = 90;
let circumference = 0;
let audioContext = null;
let scheduledNodes = [];
let alarmPrescheduled = false;
let persistTimeout = null;
let savedTimeout = null;
let toastTimeout = null;
let insightsTimeout = null;
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
  setupGuard();
  buildCharts();
  attachEvents();
  renderTasks();
  render();
  renderGuard();
  applyRoute(location.hash);

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

function snapshot() {
  return {
    version: 4,
    settings: settings,
    history: history,
    tasks: tasks,
    projectSlots: projectSlots,
    session: {
      mode: state.mode,
      cycle: state.cycle,
      round: state.round,
      remainingMs: state.remainingMs,
      endTime: state.endTime,
      isRunning: state.isRunning,
      activeTaskId: state.activeTaskId
    }
  };
}

function persist() {
  writeStore(STORAGE_KEY, JSON.stringify(snapshot()));
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

  if (saved.settings) applySavedSettings(saved.settings);
  history = sanitiseHistory(saved.history);
  tasks = sanitiseTasks(saved.tasks);
  projectSlots = sanitiseSlots(saved.projectSlots);
  invalidateDays();

  /* A v3 save has a day counter but no per-session records. Seed one
     summary row so the older total is not silently lost. */
  if (!saved.history && saved.stats && saved.stats.focusMs > 0 && saved.stats.date) {
    const midday = new Date(saved.stats.date + 'T12:00:00');
    if (!Number.isNaN(midday.getTime())) {
      history.push({
        id: 'legacy-' + saved.stats.date,
        mode: 'work',
        startedAt: midday.getTime(),
        endedAt: midday.getTime() + toInt(saved.stats.focusMs, 0),
        plannedMs: toInt(saved.stats.focusMs, 0),
        actualMs: toInt(saved.stats.focusMs, 0),
        completed: true,
        sessionCount: Math.max(1, toInt(saved.stats.completed, 1)),
        taskId: null,
        taskTitle: '',
        project: '',
        distractions: 0
      });
    }
  }

  restoreSession(saved.session);
}

function applySavedSettings(saved) {
  Object.keys(CONTROLS).forEach(function (key) {
    const control = CONTROLS[key];
    settings[control.field] = clamp(saved[control.field], control.min, control.max, DEFAULT_SETTINGS[control.field]);
  });
  settings.autoMode = saved.autoMode !== false;
  settings.strictMode = saved.strictMode === true;
  settings.soundOn = saved.soundOn !== false;
  settings.repeatAlarm = saved.repeatAlarm !== false;
  settings.flashTab = saved.flashTab !== false;
  settings.alarmSound = ALARM_SOUNDS[saved.alarmSound] ? saved.alarmSound : DEFAULT_SETTINGS.alarmSound;
  settings.ambientSound = AMBIENCES[saved.ambientSound] ? saved.ambientSound : 'none';
  settings.guardOn = saved.guardOn === true;
  settings.guardNotify = saved.guardNotify !== false;
  settings.guardSensitivity = GUARD_PATIENCE[saved.guardSensitivity] ? saved.guardSensitivity : 'balanced';
  settings.guardYaw = boundedNumber(saved.guardYaw, -0.4, 0.4, 0);
  settings.guardPitch = boundedNumber(saved.guardPitch, -0.4, 0.4, 0);
  settings.volume = normaliseVolume(saved.volume, DEFAULT_SETTINGS.volume);
  settings.ambientVolume = normaliseVolume(saved.ambientVolume, DEFAULT_SETTINGS.ambientVolume);
  settings.notificationsOn = saved.notificationsOn === true
    && 'Notification' in window
    && Notification.permission === 'granted';
}

function boundedNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normaliseVolume(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function sanitiseHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  raw.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    const startedAt = toInt(entry.startedAt, 0);
    const actualMs = Math.max(0, toInt(entry.actualMs, 0));
    if (!startedAt || !actualMs) return;
    cleaned.push({
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      mode: MODES[entry.mode] ? entry.mode : 'work',
      startedAt: startedAt,
      endedAt: Math.max(startedAt, toInt(entry.endedAt, startedAt + actualMs)),
      plannedMs: Math.max(0, toInt(entry.plannedMs, actualMs)),
      actualMs: actualMs,
      completed: entry.completed !== false,
      sessionCount: Math.max(1, toInt(entry.sessionCount, 1)),
      taskId: typeof entry.taskId === 'string' ? entry.taskId : null,
      taskTitle: typeof entry.taskTitle === 'string' ? entry.taskTitle.slice(0, 120) : '',
      project: typeof entry.project === 'string' ? entry.project.slice(0, 40) : '',
      distractions: Math.max(0, toInt(entry.distractions, 0)),
      autoFlagged: Math.max(0, toInt(entry.autoFlagged, 0))
    });
  });
  cleaned.sort(function (a, b) { return a.startedAt - b.startedAt; });
  return cleaned.slice(-HISTORY_LIMIT);
}

function sanitiseSlots(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  Object.keys(raw).forEach(function (key) {
    const slot = clamp(raw[key], 1, SERIES_SLOTS, 0);
    if (slot) clean[key] = slot;
  });
  return clean;
}

function sanitiseTasks(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  raw.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 120) : '';
    if (!title) return;
    cleaned.push({
      id: typeof entry.id === 'string' ? entry.id : makeId(),
      title: title,
      project: typeof entry.project === 'string' ? entry.project.trim().slice(0, 40) : '',
      estimate: clamp(entry.estimate, 1, 24, 2),
      done: entry.done === true,
      createdAt: toInt(entry.createdAt, Date.now())
    });
  });
  return cleaned.slice(0, 200);
}

function restoreSession(session) {
  state.remainingMs = durationFor(state.mode);
  if (!session) return;

  if (MODES[session.mode]) state.mode = session.mode;
  state.cycle = Math.max(1, toInt(session.cycle, 1));
  state.round = clamp(session.round, 0, settings.roundsBeforeLongBreak, 0);
  if (typeof session.activeTaskId === 'string') state.activeTaskId = session.activeTaskId;

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

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function dayKey(date) {
  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

function todayKey() {
  return dayKey(new Date());
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, count) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + count);
  return copy;
}

function durationFor(mode) {
  return settings[MODES[mode].field] * 60 * 1000;
}

function plural(minutes) {
  return minutes + ' minute' + (minutes > 1 ? 's' : '');
}

/* A function declaration, not a const: init() runs above this line. */
function formatMinutes(minutes) {
  return Viz.formatMinutes(minutes);
}

function formatClock(hour) {
  const suffix = hour < 12 ? 'am' : 'pm';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return display + suffix;
}

function activeTask() {
  if (!state.activeTaskId) return null;
  return tasks.find(function (task) { return task.id === state.activeTaskId; }) || null;
}

/* =========================================================
   History
   ========================================================= */
function recordSession(actualMs, completed) {
  const task = activeTask();
  const startedAt = state.startedAt || (Date.now() - actualMs);

  history.push({
    id: makeId(),
    mode: 'work',
    startedAt: startedAt,
    endedAt: Date.now(),
    plannedMs: durationFor('work'),
    actualMs: actualMs,
    completed: completed,
    sessionCount: 1,
    taskId: task ? task.id : null,
    taskTitle: task ? task.title : '',
    project: task ? task.project : '',
    distractions: state.distractions,
    autoFlagged: state.autoFlagged
  });

  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
  invalidateDays();
}

/* render() runs on every tick, so the full-history rollup is cached and
   invalidated only when history actually changes. */
function invalidateDays() {
  dayIndexCache = null;
}

function allDays() {
  if (!dayIndexCache) dayIndexCache = summariseDays(history);
  return dayIndexCache;
}

/* Work sessions grouped by calendar day. */
function summariseDays(sessions) {
  const index = new Map();
  sessions.forEach(function (entry) {
    if (entry.mode !== 'work') return;
    const key = dayKey(new Date(entry.startedAt));
    let day = index.get(key);
    if (!day) {
      day = { minutes: 0, sessions: 0, completed: 0, skipped: 0, distractions: 0, autoFlagged: 0 };
      index.set(key, day);
    }
    day.minutes += entry.actualMs / 60000;
    day.sessions += entry.sessionCount;
    day.distractions += entry.distractions;
    day.autoFlagged += entry.autoFlagged || 0;
    if (entry.completed) day.completed += entry.sessionCount;
    else day.skipped += entry.sessionCount;
  });
  return index;
}

function todaySummary() {
  const day = allDays().get(todayKey());
  return day || { minutes: 0, sessions: 0, completed: 0, skipped: 0, distractions: 0, autoFlagged: 0 };
}

/* Consecutive days, ending today or yesterday, with a completed focus session. */
function computeStreak() {
  const days = allDays();
  let cursor = startOfDay(new Date());
  if (!hasFocus(days, cursor)) {
    cursor = addDays(cursor, -1);
    if (!hasFocus(days, cursor)) return 0;
  }
  let streak = 0;
  while (hasFocus(days, cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function hasFocus(days, date) {
  const day = days.get(dayKey(date));
  return Boolean(day && day.completed > 0);
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

  if (!state.startedAt) {
    state.startedAt = Date.now();
    if (state.mode === 'work') {
      state.distractions = 0;
      state.autoFlagged = 0;
    }
  }

  state.isRunning = true;
  state.endTime = Date.now() + state.remainingMs;
  state.tickId = window.setInterval(tick, TICK_MS);

  unlockAudio();
  requestWakeLock();
  syncAmbient();
  syncGuard();
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
  syncAmbient();
  syncGuard();
}

function tick() {
  if (!state.isRunning) return;
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  prescheduleAlarm();
  render();
  if (state.remainingMs <= 0) completeSession(false);
}

function reset() {
  if (!confirmAbandon('reset the timer')) return;
  stopTicking();
  state.mode = 'work';
  state.cycle = 1;
  state.round = 0;
  state.startedAt = null;
  state.distractions = 0;
  state.autoFlagged = 0;
  state.remainingMs = durationFor('work');
  persist();
  render();
  showToast('Timer reset');
}

function skip() {
  if (!confirmAbandon('skip this session')) return;
  if (state.isRunning) {
    state.remainingMs = Math.max(0, state.endTime - Date.now());
  }
  completeSession(true);
}

/* Strict focus makes abandoning a running focus session a deliberate act. */
function confirmAbandon(action) {
  if (!settings.strictMode) return true;
  if (!state.isRunning || state.mode !== 'work') return true;
  return window.confirm('Strict focus is on. Really ' + action + '?');
}

function completeSession(wasSkipped) {
  const finished = state.mode;
  const wasWork = finished === 'work';
  const elapsedMs = Math.max(0, durationFor(finished) - Math.max(0, state.remainingMs));

  window.clearInterval(state.tickId);
  state.tickId = null;
  state.isRunning = false;
  state.endTime = null;
  releaseWakeLock();
  syncAmbient();
  syncGuard();

  if (wasWork && elapsedMs >= MIN_RECORDED_MS) {
    recordSession(elapsedMs, !wasSkipped);
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

  state.startedAt = null;
  state.distractions = 0;
  state.autoFlagged = 0;
  state.remainingMs = durationFor(state.mode);
  persist();
  scheduleInsights();

  if (wasSkipped) {
    cancelScheduledAlarm();
    render();
    renderTasks();
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
  renderTasks();
}

function logDistraction() {
  if (!state.isRunning || state.mode !== 'work') {
    showToast('Distractions are counted during a focus session');
    return;
  }
  state.distractions += 1;
  render();
}

/* =========================================================
   Tasks
   ========================================================= */
function addTask(title, project, estimate) {
  const task = {
    id: makeId(),
    title: title.trim().slice(0, 120),
    project: project.trim().slice(0, 40),
    estimate: clamp(estimate, 1, 24, 2),
    done: false,
    createdAt: Date.now()
  };
  if (!task.title) return;
  tasks.unshift(task);
  if (!state.activeTaskId) state.activeTaskId = task.id;
  persist();
  renderTasks();
  render();
}

function taskProgress(taskId) {
  let sessions = 0;
  let minutes = 0;
  history.forEach(function (entry) {
    if (entry.taskId !== taskId || entry.mode !== 'work') return;
    if (entry.completed) sessions += entry.sessionCount;
    minutes += entry.actualMs / 60000;
  });
  return { sessions: sessions, minutes: minutes };
}

function setActiveTask(taskId) {
  state.activeTaskId = state.activeTaskId === taskId ? null : taskId;
  persist();
  renderTasks();
  render();
}

function toggleTaskDone(taskId) {
  const task = tasks.find(function (entry) { return entry.id === taskId; });
  if (!task) return;
  task.done = !task.done;
  if (task.done && state.activeTaskId === taskId) state.activeTaskId = null;
  persist();
  renderTasks();
  render();
}

function removeTask(taskId) {
  tasks = tasks.filter(function (entry) { return entry.id !== taskId; });
  if (state.activeTaskId === taskId) state.activeTaskId = null;
  persist();
  renderTasks();
  render();
}

function renderTasks() {
  const list = elements.taskList;
  list.replaceChildren();

  const ordered = tasks.slice().sort(function (a, b) {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.createdAt - a.createdAt;
  });

  elements.taskEmpty.hidden = ordered.length > 0;

  ordered.forEach(function (task) {
    const progress = taskProgress(task.id);
    const item = document.createElement('li');
    item.className = 'task-item'
      + (task.done ? ' is-done' : '')
      + (task.id === state.activeTaskId ? ' is-active' : '');

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'task-check';
    check.setAttribute('role', 'checkbox');
    check.setAttribute('aria-checked', String(task.done));
    check.setAttribute('aria-label', task.done ? 'Mark as not done' : 'Mark as done');
    check.addEventListener('click', function () { toggleTaskDone(task.id); });

    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'task-body';
    body.setAttribute('aria-pressed', String(task.id === state.activeTaskId));

    const titleLine = document.createElement('span');
    titleLine.className = 'task-title-text';
    titleLine.textContent = task.title;
    body.append(titleLine);

    const meta = document.createElement('span');
    meta.className = 'task-meta';
    if (task.project) {
      const chip = document.createElement('span');
      chip.className = 'project-chip';
      const dot = document.createElement('span');
      dot.className = 'task-dot';
      dot.style.background = projectColor(task.project);
      chip.append(dot, document.createTextNode(task.project));
      meta.append(chip);
    }
    const count = document.createElement('span');
    count.className = 'task-count';
    count.textContent = progress.sessions + ' / ' + task.estimate
      + (progress.minutes >= 1 ? ' · ' + formatMinutes(progress.minutes) : '');
    meta.append(count);
    body.append(meta);

    body.addEventListener('click', function () { setActiveTask(task.id); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'task-remove';
    remove.setAttribute('aria-label', 'Remove task');
    remove.textContent = '×';
    remove.addEventListener('click', function () { removeTask(task.id); });

    item.append(check, body, remove);
    list.append(item);
  });

  renderProjectOptions();
}

function renderProjectOptions() {
  const names = new Set();
  tasks.forEach(function (task) { if (task.project) names.add(task.project); });
  history.forEach(function (entry) { if (entry.project) names.add(entry.project); });

  const datalist = elements.projectList;
  datalist.replaceChildren();
  Array.from(names).sort().forEach(function (name) {
    const option = document.createElement('option');
    option.value = name;
    datalist.append(option);
  });
}

/* Colour follows the entity, never its rank: a project is handed a slot the
   first time it is seen and keeps it for good, so re-filtering can never
   repaint the series that survive.

   A hash would be simpler but collides - three projects landing on the same
   hue in one chart is worse than any amount of bookkeeping. The least-used
   slot wins, so the first six projects are always distinct. */
function projectSlot(name) {
  const key = String(name).trim().toLowerCase();
  if (!key) return 1;
  if (projectSlots[key]) return projectSlots[key];

  const usage = new Array(SERIES_SLOTS + 1).fill(0);
  Object.keys(projectSlots).forEach(function (existing) { usage[projectSlots[existing]] += 1; });
  let best = 1;
  for (let slot = 2; slot <= SERIES_SLOTS; slot += 1) {
    if (usage[slot] < usage[best]) best = slot;
  }

  projectSlots[key] = best;
  schedulePersist();
  return best;
}

function projectColor(name) {
  return 'var(--viz-s' + projectSlot(name) + ')';
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
  document.title = alertState.flashOn ? '⏰ ' + alertState.flashTitle : 'Focusline';
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
  if (settings.soundOn || settings.ambientSound !== 'none') getAudioContext();
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

/* ---------------------------------------------------------
   Ambient soundscapes - synthesised noise, nothing to download
   --------------------------------------------------------- */
function makeNoiseBuffer(context, colour) {
  const seconds = 6;
  const length = context.sampleRate * seconds;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  if (colour === 'brown') {
    let last = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[index] = last * 3.5;
    }
  } else if (colour === 'pink') {
    /* Paul Kellet's economical pink-noise filter. */
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  } else {
    for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
  }

  /* Cross-fade the seam so the loop has no audible click. */
  const fade = Math.floor(context.sampleRate * 0.05);
  for (let index = 0; index < fade; index += 1) {
    const ratio = index / fade;
    data[index] = data[index] * ratio + data[length - fade + index] * (1 - ratio);
  }
  return buffer;
}

function startAmbient() {
  const preset = AMBIENCES[settings.ambientSound];
  if (!preset) return;
  const context = getAudioContext();
  if (!context || settings.ambientVolume <= 0) return;

  stopAmbient(0);

  const source = context.createBufferSource();
  source.buffer = makeNoiseBuffer(context, preset.noise);
  source.loop = true;

  const filter = context.createBiquadFilter();
  filter.type = preset.filter.type;
  filter.frequency.value = preset.filter.frequency;
  filter.Q.value = preset.filter.Q;

  const gain = context.createGain();
  const target = settings.ambientVolume * preset.gain;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.linearRampToValueAtTime(target, context.currentTime + 1.5);

  source.connect(filter).connect(gain).connect(context.destination);

  /* A slow swell keeps a flat noise bed from feeling mechanical. */
  if (preset.swell) {
    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.value = preset.swell;
    lfoGain.gain.value = target * 0.45;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
    ambient.lfo = lfo;
    ambient.lfoGain = lfoGain;
  }
  if (preset.shimmer) {
    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.value = preset.shimmer;
    lfoGain.gain.value = preset.filter.frequency * 0.3;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    ambient.lfo = lfo;
    ambient.lfoGain = lfoGain;
  }

  source.start();
  ambient.source = source;
  ambient.gain = gain;
  ambient.filter = filter;
}

function stopAmbient(fadeSeconds) {
  const fade = fadeSeconds === undefined ? 0.8 : fadeSeconds;
  const source = ambient.source;
  const gain = ambient.gain;
  const lfo = ambient.lfo;
  ambient.source = null;
  ambient.gain = null;
  ambient.filter = null;
  ambient.lfo = null;
  ambient.lfoGain = null;
  if (!source) return;

  const context = audioContext;
  const stopAt = context ? context.currentTime + fade : 0;
  if (gain && context && fade > 0) {
    try {
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), context.currentTime);
      gain.gain.linearRampToValueAtTime(0.0001, stopAt);
    } catch (error) { /* the ramp is a nicety, not a requirement */ }
  }
  try { source.stop(stopAt); } catch (error) { /* already stopped */ }
  if (lfo) { try { lfo.stop(stopAt); } catch (error) { /* already stopped */ } }
}

/* Ambience belongs to focus: it starts with a focus session and stops
   the moment a break begins. */
function syncAmbient() {
  const shouldPlay = state.isRunning && state.mode === 'work' && settings.ambientSound !== 'none';
  if (shouldPlay && !ambient.source) startAmbient();
  else if (!shouldPlay && ambient.source) stopAmbient();
}

function previewAmbient() {
  if (settings.ambientSound === 'none') {
    showToast('Pick a soundscape first');
    return;
  }
  unlockAudio();
  window.clearTimeout(ambient.previewTimer);
  if (ambient.source && !state.isRunning) {
    stopAmbient();
    elements.ambientPreview.textContent = 'Play preview';
    return;
  }
  startAmbient();
  elements.ambientPreview.textContent = 'Stop preview';
  ambient.previewTimer = window.setTimeout(function () {
    if (!state.isRunning) stopAmbient();
    elements.ambientPreview.textContent = 'Play preview';
  }, 12000);
}

/* =========================================================
   Attention guard - camera-based drift detection

   The model itself lives in vision.js. This half decides when it is
   allowed to look (focus sessions only), what a drift costs, and how
   you are told about it.
   ========================================================= */
function guardAvailable() {
  return Boolean(Vision && Vision.isSupported());
}

function setupGuard() {
  if (!guardAvailable()) {
    settings.guardOn = false;
    elements.guardToggle.disabled = true;
    elements.guardCalibrate.disabled = true;
    elements.guardCheck.disabled = true;
    return;
  }

  Vision.on('status', function (payload) {
    guardView.status = payload.status;
    guardView.reason = payload.reason;
    guardView.kind = payload.kind || null;
    guardView.detail = payload.detail || '';
    renderGuard(payload.detail);
  });

  Vision.on('tick', function (payload) {
    guardView.reason = payload.reason;
    guardView.pressure = payload.pressure;
    guardView.flagged = payload.flagged;
    renderGuardMeter();
  });

  Vision.on('lost', onGuardLost);

  Vision.on('regained', function () {
    guardView.flagged = false;
    renderGuardMeter();
  });

  Vision.on('calibrating', function (payload) {
    if (payload.active) {
      elements.guardCalibrate.textContent = 'Hold still, look at the screen\u2026';
      return;
    }
    elements.guardCalibrate.textContent = 'Set my neutral position';
    if (!payload.ok) {
      showToast('Could not see your face - try again in better light');
      return;
    }
    settings.guardYaw = payload.centre.yaw;
    settings.guardPitch = payload.centre.pitch;
    schedulePersist();
    showToast('Neutral position saved');
  });
}

/* The guard only counts a drift while a focus session is actually
   running: no marks during breaks, and none while the timer is paused. */
function guardShouldWatch() {
  return settings.guardOn && state.isRunning && state.mode === 'work';
}

function guardHolding() {
  return guardView.previewUntil > Date.now();
}

function syncGuard() {
  if (!guardAvailable()) return;
  /* guardHolding() stands on its own: it is only ever set by an explicit
     request to see the camera (toggling on, calibrating, or a passing
     check), and those must work even while the guard itself is off. */
  const wanted = guardShouldWatch() || guardHolding();
  const live = guardView.status === 'watching' || guardView.status === 'loading';

  /* A page served from file:// can never open a camera, so retrying each
     session would only churn. Every other failure is worth another go. */
  if (guardView.status === 'error' && guardView.kind === 'blocked') {
    renderGuard(guardView.detail);
    return;
  }

  if (wanted && !live) {
    Vision.start({
      video: elements.guardVideo,
      sensitivity: settings.guardSensitivity,
      centre: { yaw: settings.guardYaw, pitch: settings.guardPitch }
    }).then(function (ok) {
      /* Only an explicit refusal switches the feature off. A missing
         camera or a failed download keeps it armed and keeps the reason
         on screen, instead of flipping the toggle back with no
         explanation. */
      if (!ok && settings.guardOn && guardView.kind === 'denied') {
        settings.guardOn = false;
        syncToggles();
        schedulePersist();
      }
      renderGuard(guardView.detail);
    });
  } else if (!wanted && live) {
    Vision.stop();
  }
  renderGuard();
}

/* Keeps the camera up briefly so the preview is useful right after you
   switch the guard on or ask to calibrate. */
function holdGuardPreview() {
  guardView.previewUntil = Date.now() + GUARD_PREVIEW_MS;
  window.clearTimeout(guardView.holdTimer);
  guardView.holdTimer = window.setTimeout(syncGuard, GUARD_PREVIEW_MS + 200);
  syncGuard();
}

function onGuardLost(payload) {
  if (!guardShouldWatch()) return;

  const now = Date.now();
  if (now - lastAutoFlagAt < AUTO_FLAG_COOLDOWN_MS) return;
  lastAutoFlagAt = now;

  state.distractions += 1;
  state.autoFlagged += 1;
  guardView.flagged = true;

  const message = payload.message || 'Your attention drifted';
  if (settings.guardNotify) {
    playNudge();
    sendNotification('Focus drifted', message + '. Marked as a distraction.');
  }
  showToast(message + ' \u2014 marked as a distraction');

  persist();
  render();
  renderGuardChip();
}

/* Deliberately not the end-of-session alarm: this is a tap on the
   shoulder, not a bell, and it sits well under the alarm's volume. */
function playNudge() {
  const context = getAudioContext();
  if (!context || settings.volume <= 0) return;

  const base = context.currentTime + 0.02;
  const master = context.createGain();
  master.gain.value = Math.min(1, Math.max(0, settings.volume)) * 0.45;
  master.connect(context.destination);

  [{ f: 587.33, t: 0 }, { f: 440, t: 0.14 }].forEach(function (note) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(note.f, base + note.t);
    gain.gain.setValueAtTime(0.0001, base + note.t);
    gain.gain.exponentialRampToValueAtTime(0.14, base + note.t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, base + note.t + 0.3);
    oscillator.connect(gain).connect(master);
    oscillator.start(base + note.t);
    oscillator.stop(base + note.t + 0.36);
  });
}

/* Runs the camera check on demand and leaves the verdict on screen, so a
   failure can be understood without opening devtools. */
function runGuardCheck() {
  if (!guardAvailable()) return;
  const button = elements.guardCheck;
  button.disabled = true;
  button.textContent = 'Checking…';

  Vision.diagnose().then(function (report) {
    button.disabled = false;
    button.textContent = 'Check my camera';

    guardView.checked = report;

    const node = elements.guardStatus;
    node.classList.remove('warn', 'ok');
    node.textContent = report.message;
    node.classList.add(report.ok ? 'ok' : 'warn');

    if (report.ok) {
      /* Seeing yourself is the proof; a sentence saying it works is not.
         Open the preview so a passing check is visibly true. */
      holdGuardPreview();
      showToast('Everything works — showing the preview');
    } else {
      showToast('Check failed at the ' + (report.stage || 'camera') + ' stage');
    }
  }).catch(function () {
    button.disabled = false;
    button.textContent = 'Check my camera';
    showToast('The camera check could not run');
  });
}

function renderGuard(detail) {
  const status = guardView.status;
  const live = status === 'watching';
  const showing = live || status === 'loading';

  elements.guardPreview.classList.toggle('is-live', live);
  elements.guardLive.hidden = !live;
  elements.guardPreviewIdle.hidden = showing;
  elements.guardCalibrate.disabled = !live;

  /* "Camera off" on its own reads as a fault. It is usually the correct,
     intended state - the camera belongs to the focus session - so the
     placeholder says which of those it is. */
  if (!showing) {
    elements.guardPreviewIdle.textContent =
      status === 'error' ? 'Unavailable'
        : !settings.guardOn ? 'Guard is off'
          : 'Starts with your focus session';
  }

  renderGuardChip();

  const node = elements.guardStatus;
  node.classList.remove('warn', 'ok');

  if (!guardAvailable()) {
    node.textContent = 'This browser cannot run the attention guard.';
    node.classList.add('warn');
    return;
  }
  if (detail && status === 'error') {
    node.textContent = detail;
    node.classList.add('warn');
    return;
  }
  if (status === 'loading') {
    node.textContent = detail || 'Starting\u2026';
    return;
  }
  /* A check verdict outranks the generic idle copy, but never the live
     readout during a real focus session. */
  if (guardView.checked && !guardShouldWatch()) {
    node.textContent = guardView.checked.message;
    node.classList.add(guardView.checked.ok ? 'ok' : 'warn');
    return;
  }
  if (live) {
    node.textContent = guardShouldWatch()
      ? 'Watching. ' + (Vision.REASONS[guardView.reason] || '')
      : 'Camera on for the preview. It only counts drift during a focus session.';
    node.classList.add('ok');
    return;
  }
  if (settings.guardOn) {
    const blocked = Vision.blockedReason();
    if (blocked) {
      node.textContent = blocked;
      node.classList.add('warn');
      return;
    }
    node.textContent = 'Armed. The camera opens when your next focus session starts.';
    node.classList.add('ok');
    return;
  }
  node.textContent = 'Off. Switching it on asks for camera access.';
}

/* The chip lives on the timer panel and has to track the flag live, so it
   is driven from the per-frame tick rather than only from status changes. */
function renderGuardChip() {
  const live = guardView.status === 'watching';
  elements.guardChip.hidden = !(live && guardShouldWatch());
  elements.guardChip.classList.toggle('is-flagged', Boolean(guardView.flagged));
  setText('guardChip', elements.guardChipText,
    guardView.flagged ? 'Attention drifted' : 'Guard watching');
}

function renderGuardMeter() {
  renderGuardChip();
  const pressure = Math.max(0, Math.min(1, guardView.pressure || 0));
  elements.guardMeterFill.style.width = (pressure * 100).toFixed(0) + '%';
  elements.guardMeter.classList.toggle('is-hot', pressure > 0.6);
  elements.guardMeter.setAttribute('aria-label',
    guardView.reason === 'focused'
      ? 'Attention meter: on the work'
      : 'Attention meter: ' + ((Vision && Vision.REASONS[guardView.reason]) || 'drifting'));

  if (elements.guardDot) {
    elements.guardDot.className = 'guard-dot'
      + (guardView.flagged ? ' is-flagged' : (pressure > 0.4 ? ' is-warm' : ''));
  }
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
  setText('startIcon', elements.startIcon, state.isRunning ? '❙❙' : '▶');
  elements.startButton.setAttribute('aria-pressed', String(state.isRunning));

  setText('headerStatus', elements.headerStatusText, headerStatus());
  setText('nextUp', elements.nextUp, 'Next: ' + nextSessionLabel());

  renderActiveTask();
  renderDistractions();
  renderToday();
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

function renderActiveTask() {
  const task = activeTask();
  setText('activeTask', elements.activeTaskName, task ? task.title : 'Nothing selected');
  elements.activeTaskButton.classList.toggle('is-empty', !task);
  elements.activeTaskDot.style.background = task && task.project
    ? projectColor(task.project)
    : 'var(--muted)';
}

function renderDistractions() {
  const live = state.isRunning && state.mode === 'work';
  elements.distractionRow.classList.toggle('is-live', live);
  elements.distractionButton.disabled = !live;

  const count = state.distractions;
  setText('distractionCount', elements.distractionCount,
    count === 0
      ? (live ? 'Clean run so far' : 'Logged during focus')
      : count + (count === 1 ? ' distraction' : ' distractions') + ' this session');
}

function renderToday() {
  const today = todaySummary();
  const goal = settings.dailyGoalMinutes;
  const ratio = goal > 0 ? Math.min(1, today.minutes / goal) : 0;

  setText('todayFocus', elements.todayFocus, formatMinutes(today.minutes));
  setText('goalTarget', elements.goalTarget, 'of a ' + formatMinutes(goal) + ' goal');
  elements.goalFill.style.width = (ratio * 100).toFixed(1) + '%';
  elements.goalMeter.setAttribute('aria-label',
    'Daily focus goal: ' + formatMinutes(today.minutes) + ' of ' + formatMinutes(goal));
  elements.goalMeter.classList.toggle('is-complete', ratio >= 1);

  const remaining = Math.max(0, goal - today.minutes);
  setText('goalCaption', elements.goalCaption,
    today.minutes === 0 ? 'Start a session to get going.'
      : remaining === 0 ? 'Goal reached. Anything further is a bonus.'
        : formatMinutes(remaining) + ' left to reach today’s goal.');

  setText('completed', elements.completedSessions, String(today.completed));
  setText('streak', elements.streakValue, String(computeStreak()));
  setText('todayDistractions', elements.todayDistractions, String(today.distractions + (state.mode === 'work' ? state.distractions : 0)));
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
  const title = state.isRunning ? clock + ' · ' + label : 'Focusline | Deep Work Timer';
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
  elements.ambientSound.value = settings.ambientSound;
  elements.ambientVolume.value = Math.round(settings.ambientVolume * 100);
  elements.ambientVolumeValue.textContent = Math.round(settings.ambientVolume * 100) + '%';
  elements.guardSensitivity.value = settings.guardSensitivity;
  elements.guardPatienceNote.textContent = GUARD_PATIENCE[settings.guardSensitivity];
}

function syncToggles() {
  setToggle(elements.autoToggle, elements.autoLabel, settings.autoMode);
  setToggle(elements.strictToggle, elements.strictLabel, settings.strictMode);
  setToggle(elements.soundToggle, elements.soundLabel, settings.soundOn);
  setToggle(elements.repeatToggle, elements.repeatLabel, settings.repeatAlarm);
  setToggle(elements.flashToggle, elements.flashLabel, settings.flashTab);
  setToggle(elements.notifyToggle, elements.notifyLabel, settings.notificationsOn);
  setToggle(elements.guardToggle, elements.guardLabel, settings.guardOn);
  setToggle(elements.guardNotifyToggle, elements.guardNotifyLabel, settings.guardNotify);
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
  if (key === 'goal') scheduleInsights();
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  Object.keys(preset).forEach(function (field) { settings[field] = preset[field]; });
  state.round = Math.min(state.round, settings.roundsBeforeLongBreak);
  if (!state.isRunning) state.remainingMs = durationFor(state.mode);
  syncControls();
  schedulePersist();
  render();
  showToast(preset.workMinutes + ' / ' + preset.breakMinutes + ' rhythm applied');
}

function clearToday() {
  const key = todayKey();
  const before = history.length;
  history = history.filter(function (entry) { return dayKey(new Date(entry.startedAt)) !== key; });
  invalidateDays();
  state.round = 0;
  state.cycle = 1;
  state.distractions = 0;
  persist();
  render();
  renderTasks();
  scheduleInsights();
  showToast(before === history.length ? 'Nothing recorded today yet' : 'Today’s record cleared');
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
   Views
   ========================================================= */
function applyRoute(hash) {
  showView(hash === '#insights' ? 'insights' : 'timer');
}

function showView(view) {
  currentView = view;
  const insights = view === 'insights';
  elements.viewTimer.hidden = insights;
  elements.viewInsights.hidden = !insights;

  elements.tabTimer.classList.toggle('is-active', !insights);
  elements.tabInsights.classList.toggle('is-active', insights);
  if (insights) {
    elements.tabInsights.setAttribute('aria-current', 'page');
    elements.tabTimer.removeAttribute('aria-current');
  } else {
    elements.tabTimer.setAttribute('aria-current', 'page');
    elements.tabInsights.removeAttribute('aria-current');
  }

  Viz.hideTip();
  if (insights) renderInsights();
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
   Insights
   ========================================================= */
function buildCharts() {
  charts.trend = new Viz.Chart(elements.chartTrend, {
    title: 'Focus over time',
    subtitle: 'Minutes of deep work per day, against a 7-day average'
  });
  charts.calendar = new Viz.Chart(elements.chartCalendar, {
    title: 'Consistency',
    subtitle: 'Every day in range, shaded against your daily goal'
  });
  charts.hours = new Viz.Chart(elements.chartHours, {
    title: 'When you focus best',
    subtitle: 'Focus minutes by hour of the day'
  });
  charts.weekdays = new Viz.Chart(elements.chartWeekdays, {
    title: 'Weekly rhythm',
    subtitle: 'Average focus per day of the week'
  });
  charts.projects = new Viz.Chart(elements.chartProjects, {
    title: 'Where the focus went',
    subtitle: 'Share of deep work by project'
  });
  charts.quality = new Viz.Chart(elements.chartFocusQuality, {
    title: 'Interruptions',
    subtitle: 'Logged distractions per hour of focus, by week'
  });
}

function scheduleInsights() {
  if (currentView !== 'insights') return;
  window.clearTimeout(insightsTimeout);
  insightsTimeout = window.setTimeout(renderInsights, 120);
}

function rangeBounds() {
  const end = startOfDay(new Date());
  if (insightsRange === 'all') {
    const first = history.length ? startOfDay(new Date(history[0].startedAt)) : end;
    const span = Math.round((end - first) / 86400000) + 1;
    return { start: first, end: end, days: Math.max(30, Math.min(span, 371)) };
  }
  return { start: addDays(end, -(insightsRange - 1)), end: end, days: insightsRange };
}

function sessionsBetween(startDate, endDate) {
  const from = startDate.getTime();
  const to = addDays(endDate, 1).getTime();
  return history.filter(function (entry) {
    return entry.mode === 'work' && entry.startedAt >= from && entry.startedAt < to;
  });
}

function totals(sessions) {
  let minutes = 0;
  let count = 0;
  let completed = 0;
  let distractions = 0;
  sessions.forEach(function (entry) {
    minutes += entry.actualMs / 60000;
    count += entry.sessionCount;
    if (entry.completed) completed += entry.sessionCount;
    distractions += entry.distractions;
  });
  return { minutes: minutes, count: count, completed: completed, distractions: distractions };
}

function renderInsights() {
  const bounds = rangeBounds();
  const start = insightsRange === 'all' ? addDays(bounds.end, -(bounds.days - 1)) : bounds.start;
  const sessions = sessionsBetween(start, bounds.end);
  const days = summariseDays(sessions);

  renderSummary(sessions, start, bounds);
  renderTrendChart(days, start, bounds);
  renderCalendarChart(days, start, bounds);
  renderHoursChart(sessions);
  renderWeekdayChart(days, start, bounds);
  renderProjectsChart(sessions);
  renderQualityChart(sessions, start, bounds);

  const oldest = history.length ? new Date(history[0].startedAt) : null;
  elements.dataSummary.textContent = history.length
    ? history.length + ' sessions recorded since '
      + oldest.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      + ' · everything stays on this device.'
    : 'Nothing recorded yet · everything stays on this device.';
}

function renderSummary(sessions, start, bounds) {
  const current = totals(sessions);
  const previousStart = addDays(start, -bounds.days);
  const previous = totals(sessionsBetween(previousStart, addDays(start, -1)));

  elements.heroValue.textContent = formatMinutes(current.minutes);
  setDelta(elements.heroDelta, current.minutes, previous.minutes, formatMinutes, 'vs previous ' + bounds.days + ' days');

  elements.kpiSessions.textContent = String(current.completed);
  setDelta(elements.kpiSessionsDelta, current.completed, previous.completed,
    function (value) { return String(Math.round(value)); }, 'vs previous period');

  const average = current.completed > 0 ? current.minutes / current.completed : 0;
  const previousAverage = previous.completed > 0 ? previous.minutes / previous.completed : 0;
  elements.kpiAverage.textContent = average > 0 ? formatMinutes(average) : '–';
  setDelta(elements.kpiAverageDelta, average, previousAverage, formatMinutes, 'vs previous period');

  const daily = current.minutes / bounds.days;
  elements.kpiDaily.textContent = formatMinutes(daily);
  const dayIndex = summariseDays(sessions);
  const sparkValues = [];
  for (let index = 0; index < bounds.days; index += 1) {
    const day = dayIndex.get(dayKey(addDays(start, index)));
    sparkValues.push(day ? day.minutes : 0);
  }
  const hasSpark = sparkValues.some(function (value) { return value > 0; });
  Viz.sparkline(elements.kpiDailySpark, hasSpark ? sparkValues.slice(-24) : null);

  const streak = computeStreak();
  elements.kpiStreak.textContent = String(streak);
  elements.kpiStreakDetail.textContent = streak === 0
    ? 'Finish a session to start one'
    : streak === 1 ? 'day in a row' : 'days in a row';

  const attempted = current.count;
  elements.kpiCompletion.textContent = attempted > 0
    ? Math.round((current.completed / attempted) * 100) + '%'
    : '–';
  elements.kpiCompletionDetail.textContent = attempted > 0
    ? current.completed + ' of ' + attempted + ' ran to the end'
    : 'No sessions yet';

  const focusHours = current.minutes / 60;
  const rate = focusHours >= 0.5 ? current.distractions / focusHours : null;
  elements.kpiDistraction.textContent = rate === null ? '–' : (Math.round(rate * 10) / 10).toFixed(1);
  const flagged = sessions.reduce(function (sum, entry) { return sum + (entry.autoFlagged || 0); }, 0);
  elements.kpiDistractionDetail.textContent = rate === null
    ? 'Log a few to see the rate'
    : current.distractions + ' logged in ' + formatMinutes(current.minutes)
      + (flagged ? ' · ' + flagged + ' caught by the camera' : '');
}

/* Direction, and whether up is good, decide the colour. */
function setDelta(node, current, previous, format, caption) {
  node.classList.remove('is-up', 'is-down');
  if (!previous) {
    node.textContent = current > 0 ? 'No comparable period' : '';
    return;
  }
  const difference = current - previous;
  const percent = Math.round((difference / previous) * 100);
  if (Math.abs(percent) < 1) {
    node.textContent = 'Level ' + caption;
    return;
  }
  node.classList.add(difference > 0 ? 'is-up' : 'is-down');
  node.textContent = (difference > 0 ? '↑ ' : '↓ ') + Math.abs(percent) + '% ' + caption;
}

/* Daily buckets stay readable to about four months; past that the chart
   switches to weeks rather than drawing 300 hairline columns. */
function bucketPlan(days) {
  return days > 120 ? { size: 7, window: 4, label: 'week' } : { size: 1, window: 7, label: 'day' };
}

function renderTrendChart(days, start, bounds) {
  const plan = bucketPlan(bounds.days);
  const buckets = [];

  for (let offset = 0; offset < bounds.days; offset += plan.size) {
    const from = addDays(start, offset);
    let minutes = 0;
    let sessions = 0;
    for (let step = 0; step < plan.size && offset + step < bounds.days; step += 1) {
      const day = days.get(dayKey(addDays(from, step)));
      if (day) {
        minutes += day.minutes;
        sessions += day.sessions;
      }
    }
    buckets.push({
      date: from,
      value: minutes,
      sessions: sessions,
      label: plan.size === 1
        ? from.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        : 'Week of ' + from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      short: plan.size === 1
        ? from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    });
  }

  /* Trailing average over a full window, so the line never starts on a
     partial one. */
  buckets.forEach(function (bucket, index) {
    if (index < plan.window - 1) {
      bucket.trend = null;
      return;
    }
    let sum = 0;
    for (let step = 0; step < plan.window; step += 1) sum += buckets[index - step].value;
    bucket.trend = sum / plan.window;
  });

  charts.trend.options.subtitle = plan.size === 1
    ? 'Minutes of deep work per day, against a 7-day average'
    : 'Minutes of deep work per week, against a 4-week average';
  charts.trend.container.querySelector('.chart-sub').textContent = charts.trend.options.subtitle;

  charts.trend.update({
    type: 'trend',
    points: buckets,
    goal: settings.dailyGoalMinutes * plan.size,
    height: 190,
    ariaLabel: 'Focus minutes per ' + plan.label + ' with a trailing average',
    emptyMessage: 'No focus sessions in this range yet.'
  });
}

function renderCalendarChart(days, start, bounds) {
  /* Whole weeks, Monday-first, so the grid reads as a calendar. */
  const first = startOfDay(start);
  const weekdayOffset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -weekdayOffset);
  const totalDays = Math.ceil((bounds.days + weekdayOffset) / 7) * 7;
  const goal = settings.dailyGoalMinutes;
  const endTime = bounds.end.getTime();
  const cells = [];

  for (let index = 0; index < totalDays; index += 1) {
    const date = addDays(gridStart, index);
    if (date.getTime() > endTime) break;

    /* Days before the range exist only to square off the first week; drawn
       as cells they would read as "no focus", which is a different claim. */
    if (date.getTime() < first.getTime()) {
      cells.push({ date: date, outside: true, level: 0, minutes: 0, sessions: 0,
        monthShort: date.toLocaleDateString(undefined, { month: 'short' }), label: '' });
      continue;
    }

    const day = days.get(dayKey(date));
    const minutes = day ? day.minutes : 0;
    const ratio = goal > 0 ? minutes / goal : 0;
    let level = 0;
    if (minutes > 0) level = ratio >= 1 ? 4 : ratio >= 0.66 ? 3 : ratio >= 0.33 ? 2 : 1;

    cells.push({
      date: date,
      level: level,
      minutes: minutes,
      sessions: day ? day.sessions : 0,
      monthShort: date.toLocaleDateString(undefined, { month: 'short' }),
      label: date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    });
  }

  /* The renderer reads column-major (7 rows per week). */
  const ordered = [];
  const weeks = Math.ceil(cells.length / 7);
  for (let week = 0; week < weeks; week += 1) {
    for (let row = 0; row < 7; row += 1) {
      const cell = cells[week * 7 + row];
      if (cell) ordered.push(cell);
    }
  }

  charts.calendar.update({
    type: 'calendar',
    days: ordered,
    ariaLabel: 'Daily focus calendar shaded against the daily goal',
    emptyMessage: 'No history yet.',
    note: 'Shading is a share of your ' + formatMinutes(goal) + ' daily goal.'
  });
}

function renderHoursChart(sessions) {
  const hours = new Array(24).fill(0);

  /* A 90-minute session spans several hours: split it across them rather
     than crediting the whole block to the hour it started in. */
  sessions.forEach(function (entry) {
    let cursor = entry.startedAt;
    const finish = cursor + entry.actualMs;
    while (cursor < finish) {
      const slot = new Date(cursor);
      const nextHour = new Date(slot);
      nextHour.setMinutes(60, 0, 0);
      const chunkEnd = Math.min(finish, nextHour.getTime());
      hours[slot.getHours()] += (chunkEnd - cursor) / 60000;
      cursor = chunkEnd;
    }
  });

  charts.hours.update({
    type: 'columns',
    bars: hours.map(function (minutes, hour) {
      return {
        value: minutes,
        label: formatClock(hour) + ' – ' + formatClock((hour + 1) % 24),
        short: formatClock(hour)
      };
    }),
    labelStride: 3,
    height: 140,
    ariaLabel: 'Focus minutes by hour of the day',
    emptyMessage: 'Finish a few sessions to find your best hours.',
    note: 'Your peak hour is the one worth defending.'
  });
}

function renderWeekdayChart(days, start, bounds) {
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const totalsByDay = new Array(7).fill(0);
  const counts = new Array(7).fill(0);

  for (let index = 0; index < bounds.days; index += 1) {
    const date = addDays(start, index);
    const slot = (date.getDay() + 6) % 7;
    const day = days.get(dayKey(date));
    totalsByDay[slot] += day ? day.minutes : 0;
    counts[slot] += 1;
  }

  charts.weekdays.update({
    type: 'columns',
    bars: names.map(function (name, index) {
      return {
        value: counts[index] ? totalsByDay[index] / counts[index] : 0,
        label: name,
        short: name.slice(0, 3),
        detail: counts[index] + (counts[index] === 1 ? ' day' : ' days'),
        detailLabel: 'in range'
      };
    }),
    height: 140,
    categoryHeading: 'Day',
    valueHeading: 'Average focus',
    ariaLabel: 'Average focus minutes by day of the week',
    emptyMessage: 'Not enough sessions yet.'
  });
}

function renderProjectsChart(sessions) {
  const byProject = new Map();
  sessions.forEach(function (entry) {
    const name = entry.project || entry.taskTitle || 'Unassigned';
    let slice = byProject.get(name);
    if (!slice) {
      slice = { label: name, value: 0, sessions: 0 };
      byProject.set(name, slice);
    }
    slice.value += entry.actualMs / 60000;
    slice.sessions += entry.sessionCount;
  });

  const ordered = Array.from(byProject.values()).sort(function (a, b) { return b.value - a.value; });

  /* Past five, the tail folds into "Other" - never a generated hue. */
  const slices = ordered.slice(0, 5).map(function (slice) {
    return Object.assign({}, slice, { color: projectColor(slice.label) });
  });
  const tail = ordered.slice(5);
  if (tail.length) {
    slices.push({
      label: 'Other (' + tail.length + ')',
      value: tail.reduce(function (sum, slice) { return sum + slice.value; }, 0),
      sessions: tail.reduce(function (sum, slice) { return sum + slice.sessions; }, 0),
      color: 'var(--viz-other)'
    });
  }

  charts.projects.update({
    type: 'split',
    slices: slices,
    ariaLabel: 'Share of focus time by project',
    emptyMessage: 'Give your tasks a project to see the split.'
  });
}

function renderQualityChart(sessions, start, bounds) {
  const weeks = [];
  const weekCount = Math.max(1, Math.ceil(bounds.days / 7));

  for (let index = 0; index < weekCount; index += 1) {
    const from = addDays(start, index * 7);
    const to = addDays(from, 7);
    let minutes = 0;
    let distractions = 0;
    sessions.forEach(function (entry) {
      if (entry.startedAt < from.getTime() || entry.startedAt >= to.getTime()) return;
      minutes += entry.actualMs / 60000;
      distractions += entry.distractions;
    });
    /* Under 15 minutes a rate is noise, not a reading. */
    weeks.push({
      value: minutes >= 15 ? distractions / (minutes / 60) : null,
      label: 'Week of ' + from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      short: from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      detail: formatMinutes(minutes),
      detailLabel: 'focused'
    });
  }

  charts.quality.update({
    type: 'line',
    points: weeks,
    height: 130,
    valueLabel: 'per focus hour',
    valueHeading: 'Interruptions / hour',
    ariaLabel: 'Logged interruptions per hour of focus, by week',
    emptyMessage: 'Log distractions during focus to track this.',
    note: 'Lower is deeper. Weeks under 15 minutes of focus are left out.'
  });
}

/* =========================================================
   Import / export
   ========================================================= */
function download(filename, contents, type) {
  try {
    const blob = new Blob([contents], { type: type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast('Saved ' + filename);
  } catch (error) {
    showToast('This browser blocked the download');
  }
}

function exportJson() {
  download('focusline-backup-' + todayKey() + '.json', JSON.stringify(snapshot(), null, 2), 'application/json');
}

function exportCsv() {
  const header = ['started_at', 'ended_at', 'minutes', 'planned_minutes', 'completed', 'task', 'project', 'distractions', 'camera_flagged'];
  const rows = history.filter(function (entry) { return entry.mode === 'work'; }).map(function (entry) {
    return [
      new Date(entry.startedAt).toISOString(),
      new Date(entry.endedAt).toISOString(),
      (entry.actualMs / 60000).toFixed(2),
      (entry.plannedMs / 60000).toFixed(2),
      entry.completed ? 'yes' : 'skipped',
      csvCell(entry.taskTitle),
      csvCell(entry.project),
      String(entry.distractions),
      String(entry.autoFlagged || 0)
    ].join(',');
  });
  download('focusline-sessions-' + todayKey() + '.csv', [header.join(',')].concat(rows).join('\r\n'), 'text/csv');
}

function csvCell(value) {
  const text = String(value || '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = function () {
    let parsed = null;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (error) {
      showToast('That file is not a Focusline backup');
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      showToast('That file is not a Focusline backup');
      return;
    }

    const incoming = sanitiseHistory(parsed.history);
    const incomingTasks = sanitiseTasks(parsed.tasks);
    if (!incoming.length && !incomingTasks.length && !parsed.settings) {
      showToast('Nothing to import from that file');
      return;
    }
    if (!window.confirm('Merge ' + incoming.length + ' sessions and ' + incomingTasks.length
      + ' tasks into this device? Existing records are kept.')) return;

    /* Merge, not replace: a re-imported backup must not duplicate rows. */
    const seen = new Set(history.map(function (entry) { return entry.id; }));
    incoming.forEach(function (entry) {
      if (seen.has(entry.id)) return;
      seen.add(entry.id);
      history.push(entry);
    });
    history.sort(function (a, b) { return a.startedAt - b.startedAt; });
    history = history.slice(-HISTORY_LIMIT);
    invalidateDays();

    const taskIds = new Set(tasks.map(function (task) { return task.id; }));
    incomingTasks.forEach(function (task) {
      if (taskIds.has(task.id)) return;
      taskIds.add(task.id);
      tasks.push(task);
    });

    if (parsed.settings) {
      applySavedSettings(parsed.settings);
      syncControls();
      syncToggles();
    }

    persist();
    render();
    renderTasks();
    scheduleInsights();
    showToast('Imported ' + incoming.length + ' sessions');
  };
  reader.onerror = function () { showToast('That file could not be read'); };
  reader.readAsText(file);
}

function wipeEverything() {
  if (!window.confirm('Erase every session, task and setting on this device? This cannot be undone.')) return;
  if (!window.confirm('Really erase everything? Export a backup first if you want to keep it.')) return;

  history = [];
  tasks = [];
  projectSlots = {};
  invalidateDays();
  state.activeTaskId = null;
  state.round = 0;
  state.cycle = 1;
  state.distractions = 0;
  Object.keys(DEFAULT_SETTINGS).forEach(function (key) { settings[key] = DEFAULT_SETTINGS[key]; });
  if (Vision) Vision.stop();
  if (!state.isRunning) state.remainingMs = durationFor(state.mode);

  syncControls();
  syncToggles();
  persist();
  render();
  renderTasks();
  scheduleInsights();
  showToast('Everything erased');
}

/* =========================================================
   Events
   ========================================================= */
function attachEvents() {
  elements.startButton.addEventListener('click', function () { clearAlert(); start(); });
  elements.resetButton.addEventListener('click', function () { clearAlert(); reset(); });
  elements.skipButton.addEventListener('click', function () { clearAlert(); skip(); });
  elements.distractionButton.addEventListener('click', logDistraction);
  elements.alertDismiss.addEventListener('click', clearAlert);
  elements.fullscreenButton.addEventListener('click', toggleFullscreen);
  elements.themeToggle.addEventListener('click', cycleTheme);
  elements.resetStats.addEventListener('click', clearToday);

  elements.activeTaskButton.addEventListener('click', function () {
    if (currentView !== 'timer') showView('timer');
    elements.taskTitle.focus();
  });

  elements.tabTimer.addEventListener('click', function () { location.hash = '#timer'; showView('timer'); });
  elements.tabInsights.addEventListener('click', function () { location.hash = '#insights'; showView('insights'); });
  window.addEventListener('hashchange', function () { applyRoute(location.hash); });

  document.querySelectorAll('.range-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      const value = chip.dataset.range;
      insightsRange = value === 'all' ? 'all' : Number(value);
      document.querySelectorAll('.range-chip').forEach(function (other) {
        const active = other === chip;
        other.classList.toggle('is-active', active);
        if (active) other.setAttribute('aria-pressed', 'true');
        else other.removeAttribute('aria-pressed');
      });
      renderInsights();
    });
  });

  document.querySelectorAll('.preset').forEach(function (button) {
    button.addEventListener('click', function () { applyPreset(button.dataset.preset); });
  });

  elements.taskForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const title = elements.taskTitle.value.trim();
    if (!title) return;
    addTask(title, elements.taskProject.value, elements.taskEstimate.value);
    elements.taskTitle.value = '';
    elements.taskTitle.focus();
  });

  elements.clearDoneTasks.addEventListener('click', function () {
    const before = tasks.length;
    tasks = tasks.filter(function (task) { return !task.done; });
    if (before === tasks.length) {
      showToast('No finished tasks to clear');
      return;
    }
    persist();
    renderTasks();
    showToast('Finished tasks cleared');
  });

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

  elements.strictToggle.addEventListener('click', function () {
    settings.strictMode = !settings.strictMode;
    syncToggles();
    schedulePersist();
    showToast(settings.strictMode ? 'Strict focus on: leaving a session asks first' : 'Strict focus off');
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

  elements.guardToggle.addEventListener('click', function () {
    settings.guardOn = !settings.guardOn;
    syncToggles();
    schedulePersist();
    if (settings.guardOn) {
      guardView.checked = null;
      holdGuardPreview();
      showToast('Focus guard on - the camera opens during focus sessions');
    } else {
      guardView.previewUntil = 0;
      window.clearTimeout(guardView.holdTimer);
      syncGuard();
      showToast('Focus guard off - the camera is released');
    }
  });

  elements.guardNotifyToggle.addEventListener('click', function () {
    settings.guardNotify = !settings.guardNotify;
    syncToggles();
    schedulePersist();
  });

  elements.guardSensitivity.addEventListener('change', function () {
    const value = elements.guardSensitivity.value;
    settings.guardSensitivity = GUARD_PATIENCE[value] ? value : 'balanced';
    elements.guardPatienceNote.textContent = GUARD_PATIENCE[settings.guardSensitivity];
    if (Vision) Vision.setSensitivity(settings.guardSensitivity);
    schedulePersist();
  });

  elements.guardCheck.addEventListener('click', runGuardCheck);

  elements.guardCalibrate.addEventListener('click', function () {
    if (!Vision) return;
    holdGuardPreview();
    if (!Vision.calibrate()) showToast('Wait for the camera to start, then try again');
  });

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

  elements.ambientSound.addEventListener('change', function () {
    settings.ambientSound = AMBIENCES[elements.ambientSound.value] ? elements.ambientSound.value : 'none';
    schedulePersist();
    if (ambient.source) stopAmbient(0.2);
    elements.ambientPreview.textContent = 'Play preview';
    syncAmbient();
  });

  elements.ambientVolume.addEventListener('input', function () {
    settings.ambientVolume = clamp(elements.ambientVolume.value, 0, 100, 35) / 100;
    elements.ambientVolumeValue.textContent = Math.round(settings.ambientVolume * 100) + '%';
    schedulePersist();

    /* Follow the slider live instead of restarting the noise bed. */
    const preset = AMBIENCES[settings.ambientSound];
    if (ambient.gain && preset && audioContext) {
      ambient.gain.gain.setTargetAtTime(
        settings.ambientVolume * preset.gain, audioContext.currentTime, 0.1
      );
    }
  });

  elements.ambientPreview.addEventListener('click', previewAmbient);

  Object.keys(CONTROLS).forEach(function (key) {
    const control = CONTROLS[key];
    const numberField = elements[control.number];
    const rangeField = elements[control.range];
    numberField.addEventListener('input', function () { handleControlInput(key, numberField.value, false); });
    numberField.addEventListener('change', function () { handleControlInput(key, numberField.value, true); });
    numberField.addEventListener('blur', function () { handleControlInput(key, numberField.value, true); });
    rangeField.addEventListener('input', function () { handleControlInput(key, rangeField.value, true); });
  });

  elements.exportJson.addEventListener('click', exportJson);
  elements.exportCsv.addEventListener('click', exportCsv);
  elements.importButton.addEventListener('click', function () { elements.importInput.click(); });
  elements.importInput.addEventListener('change', function () {
    const file = elements.importInput.files && elements.importInput.files[0];
    if (file) importBackup(file);
    elements.importInput.value = '';
  });
  elements.wipeData.addEventListener('click', wipeEverything);

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
    if (state.isRunning) {
      requestWakeLock();
      tick();
    }
    render();
    syncGuard();
    scheduleInsights();
  });

  window.addEventListener('beforeunload', persist);
  window.addEventListener('pagehide', function () {
    persist();
    if (Vision) Vision.stop();
  });
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

  if (event.code === 'KeyI') {
    const next = currentView === 'insights' ? 'timer' : 'insights';
    location.hash = '#' + next;
    showView(next);
    return;
  }

  /* The rest drive the timer, so they only apply where the timer is. */
  if (currentView !== 'timer') return;

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
    case 'KeyD':
      logDistraction();
      break;
    case 'KeyF':
      toggleFullscreen();
      break;
    default:
      break;
  }
}
