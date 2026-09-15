const STORAGE_KEY = 'focusline-pomodoro-settings';
const DEFAULTS = { workMinutes: 25, breakMinutes: 5, autoMode: true, completed: 0 };
const CIRCUMFERENCE = 2 * Math.PI * 164;

const state = {
  mode: 'work',
  isRunning: false,
  cycle: 1,
  endTime: null,
  remainingMs: DEFAULTS.workMinutes * 60 * 1000,
  workMinutes: DEFAULTS.workMinutes,
  breakMinutes: DEFAULTS.breakMinutes,
  autoMode: DEFAULTS.autoMode,
  completed: DEFAULTS.completed,
  tickId: null
};

const elements = {
  time: document.querySelector('#timeDisplay'),
  caption: document.querySelector('#timeCaption'),
  modeLabel: document.querySelector('#modeLabel'),
  modePill: document.querySelector('#modePill'),
  ring: document.querySelector('#timerRing'),
  progress: document.querySelector('#progressRing'),
  cycle: document.querySelector('#cycleNumber'),
  timerPanel: document.querySelector('#timerPanel'),
  fullscreen: document.querySelector('#fullscreenButton'),
  start: document.querySelector('#startButton'),
  reset: document.querySelector('#resetButton'),
  skip: document.querySelector('#skipButton'),
  headerStatus: document.querySelector('#headerStatus'),
  sessionState: document.querySelector('#sessionState'),
  completed: document.querySelector('#completedSessions'),
  focusMinutes: document.querySelector('#focusMinutes'),
  trackDots: document.querySelector('#trackDots'),
  trackCount: document.querySelector('#trackCount'),
  workInput: document.querySelector('#workDuration'),
  breakInput: document.querySelector('#breakDuration'),
  workRange: document.querySelector('#workRange'),
  breakRange: document.querySelector('#breakRange'),
  autoToggle: document.querySelector('#autoToggle'),
  autoLabel: document.querySelector('#autoLabel'),
  saved: document.querySelector('#savedLabel'),
  toast: document.querySelector('#toast')
};

defineInitialState();

function defineInitialState() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (saved) {
    state.workMinutes = clamp(saved.workMinutes, 1, 120);
    state.breakMinutes = clamp(saved.breakMinutes, 1, 60);
    state.autoMode = saved.autoMode !== false;
    state.completed = Number.isFinite(saved.completed) ? saved.completed : 0;
  }
  state.remainingMs = state.workMinutes * 60 * 1000;
  elements.workInput.value = state.workMinutes;
  elements.workRange.value = state.workMinutes;
  elements.breakInput.value = state.breakMinutes;
  elements.breakRange.value = state.breakMinutes;
  updateAutoControl();
  updateDisplay();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    workMinutes: state.workMinutes,
    breakMinutes: state.breakMinutes,
    autoMode: state.autoMode,
    completed: state.completed
  }));
  elements.saved.textContent = 'Saved just now';
  window.clearTimeout(saveSettings.timeout);
  saveSettings.timeout = window.setTimeout(() => { elements.saved.textContent = 'Saved automatically'; }, 1800);
}

function updateDisplay() {
  const totalMs = (state.mode === 'work' ? state.workMinutes : state.breakMinutes) * 60 * 1000;
  const remainingMs = Math.max(0, state.remainingMs);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  const progress = totalMs ? remainingMs / totalMs : 0;
  elements.time.textContent = `${minutes}:${seconds}`;
  elements.caption.textContent = state.mode === 'work' ? 'minutes remaining' : 'time to reset';
  elements.modeLabel.textContent = state.mode === 'work' ? 'WORK SESSION' : 'BREAK SESSION';
  elements.modePill.classList.toggle('break', state.mode === 'break');
  elements.ring.classList.toggle('break', state.mode === 'break');
  elements.cycle.textContent = String(state.cycle).padStart(2, '0');
  elements.progress.style.strokeDasharray = CIRCUMFERENCE;
  elements.progress.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);
  elements.start.innerHTML = state.isRunning ? '<span class="button-icon" aria-hidden="true">Ⅱ</span>Pause' : '<span class="button-icon" aria-hidden="true">▶</span>Start focus';
  elements.headerStatus.textContent = state.isRunning ? (state.mode === 'work' ? 'Focus in progress' : 'Rest in progress') : 'Ready to focus';
  elements.sessionState.textContent = state.isRunning ? 'Active' : 'Ready';
  elements.completed.textContent = state.completed;
  elements.focusMinutes.textContent = state.completed * state.workMinutes;
  updateTrack();
}

function updateTrack() {
  elements.trackDots.innerHTML = '';
  const visibleDots = Math.max(4, Math.min(8, Math.ceil(state.completed / 4) * 4 || 4));
  for (let index = 0; index < visibleDots; index += 1) {
    const dot = document.createElement('span');
    dot.className = `track-dot${index < state.completed ? ' complete' : ''}`;
    elements.trackDots.append(dot);
  }
  elements.trackCount.textContent = `${state.completed} / ${visibleDots}`;
}

function updateAutoControl() {
  elements.autoToggle.setAttribute('aria-checked', String(state.autoMode));
  elements.autoLabel.textContent = state.autoMode ? 'On' : 'Off';
}

async function toggleFullscreen() {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (!document.documentElement.requestFullscreen) {
    showToast('Fullscreen is not supported here');
    return;
  }
  await elements.timerPanel.requestFullscreen();
}

function updateFullscreenControl() {
  const isFullscreen = Boolean(document.fullscreenElement);
  elements.fullscreen.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
  elements.fullscreen.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
}

function startTimer() {
  if (state.isRunning) {
    pauseTimer();
    return;
  }
  state.isRunning = true;
  state.endTime = Date.now() + state.remainingMs;
  state.tickId = window.setInterval(updateTimer, 200);
  updateDisplay();
}

function pauseTimer() {
  if (!state.isRunning) return;
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  state.isRunning = false;
  state.endTime = null;
  window.clearInterval(state.tickId);
  state.tickId = null;
  updateDisplay();
}

function resetTimer() {
  pauseTimer();
  state.mode = 'work';
  state.cycle = 1;
  state.remainingMs = state.workMinutes * 60 * 1000;
  updateDisplay();
  showToast('Timer reset');
}

function skipSession() {
  pauseTimer();
  completeSession(true);
}

function updateTimer() {
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  updateDisplay();
  if (state.remainingMs <= 0) completeSession(false);
}

function completeSession(wasSkipped) {
  const completedWork = state.mode === 'work';
  pauseTimer();
  if (completedWork) state.completed += 1;
  playNotificationSound();
  sendBrowserNotification(completedWork ? 'Focus session complete' : 'Break complete', completedWork ? 'A well-earned break is ready.' : 'Ready to focus again?');
  state.mode = completedWork ? 'break' : 'work';
  if (!completedWork) state.cycle += 1;
  state.remainingMs = (state.mode === 'work' ? state.workMinutes : state.breakMinutes) * 60 * 1000;
  saveSettings();
  updateDisplay();
  showToast(wasSkipped ? `${completedWork ? 'Focus' : 'Break'} skipped` : `${completedWork ? 'Focus complete' : 'Break complete'}`);
  if (state.autoMode && !wasSkipped) startTimer();
}

function playNotificationSound() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.16].forEach((delay, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = index ? 660 : 520;
      gain.gain.setValueAtTime(0.0001, context.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + delay + 0.2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + delay);
      oscillator.stop(context.currentTime + delay + 0.21);
    });
  } catch (error) { /* Audio is optional when browser policy blocks it. */ }
}

function sendBrowserNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove('show'), 2200);
}

function updateDuration(type, value) {
  const limit = type === 'work' ? 120 : 60;
  const nextValue = clamp(value, 1, limit);
  state[`${type}Minutes`] = nextValue;
  elements[`${type}Input`].value = nextValue;
  elements[`${type}Range`].value = nextValue;
  if (!state.isRunning) state.remainingMs = nextValue * 60 * 1000;
  saveSettings();
  updateDisplay();
}

elements.start.addEventListener('click', () => { requestNotificationPermission(); startTimer(); });
elements.fullscreen.addEventListener('click', () => toggleFullscreen().catch(() => showToast('Fullscreen could not be opened')));
elements.reset.addEventListener('click', resetTimer);
elements.skip.addEventListener('click', skipSession);
elements.autoToggle.addEventListener('click', () => { state.autoMode = !state.autoMode; updateAutoControl(); saveSettings(); showToast(`Automatic mode ${state.autoMode ? 'on' : 'off'}`); });
elements.workInput.addEventListener('change', (event) => updateDuration('work', event.target.value));
elements.breakInput.addEventListener('change', (event) => updateDuration('break', event.target.value));
elements.workRange.addEventListener('input', (event) => updateDuration('work', event.target.value));
elements.breakRange.addEventListener('input', (event) => updateDuration('break', event.target.value));
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !['INPUT', 'BUTTON'].includes(document.activeElement.tagName)) { event.preventDefault(); startTimer(); }
});
window.addEventListener('beforeunload', () => { if (state.isRunning) state.remainingMs = Math.max(0, state.endTime - Date.now()); });
document.addEventListener('fullscreenchange', updateFullscreenControl);
