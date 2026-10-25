(() => {
  'use strict';

  const STORAGE_KEY = 'daymark-data-v1';
  const THEME_KEY = 'daymark-theme';
  const DB_NAME = 'daymark-local';
  const DB_STORE = 'app-state';
  const categories = {
    Fitness: { emoji: '◉', color: '#e9f6ef', ink: '#3e9b70' },
    Work: { emoji: '▣', color: '#edf1fc', ink: '#637bc0' },
    Mindfulness: { emoji: '✳', color: '#f2edff', ink: '#8169c8' },
    Learning: { emoji: '⌑', color: '#fff2e5', ink: '#d28a4f' },
    Wellness: { emoji: '♡', color: '#fff0f1', ink: '#d87989' },
    Personal: { emoji: '✦', color: '#eaf5f6', ink: '#4b9da0' }
  };
  const $ = (selector) => document.querySelector(selector);
  const state = { routines: [], completions: {}, database: null, editingId: null, toastTimer: null };
  const today = () => dateKey(new Date());
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDate = (key) => { const [year, month, day] = key.split('-').map(Number); return new Date(year, month - 1, day); };
  const shiftDate = (date, days) => { const shifted = new Date(date); shifted.setDate(shifted.getDate() + days); return shifted; };
  const startOfWeek = (date) => { const start = new Date(date); start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0); return start; };
  const sameWeek = (a, b) => dateKey(startOfWeek(a)) === dateKey(startOfWeek(b));
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  function validState(value) {
    if (!value || !Array.isArray(value.routines) || !value.completions || typeof value.completions !== 'object') return false;
    return value.routines.every((routine) => routine && typeof routine.id === 'string' && typeof routine.name === 'string' && ['daily', 'weekly', 'specific'].includes(routine.frequency));
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DB_STORE)) database.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open local database.'));
    });
  }

  function readDatabase(database) {
    return new Promise((resolve, reject) => {
      const request = database.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('state');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Unable to read local database.'));
    });
  }

  function saveDatabase() {
    if (!state.database) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = state.database.transaction(DB_STORE, 'readwrite');
      transaction.objectStore(DB_STORE).put({ routines: state.routines, completions: state.completions }, 'state');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Unable to save local database.'));
      transaction.onabort = () => reject(transaction.error || new Error('Local database save was cancelled.'));
    });
  }

  async function persist() {
    const snapshot = { routines: state.routines, completions: state.completions };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      showToast(`Could not save in this browser: ${error.message}`);
      throw error;
    }
    await saveDatabase();
  }

  async function initialize() {
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (!validState(parsed)) throw new Error('Saved tracker data is invalid.');
        state.routines = parsed.routines;
        state.completions = parsed.completions;
      }
    } catch (error) {
      showToast(`Local data could not be loaded: ${error.message}`);
      state.routines = [];
      state.completions = {};
    }
    if (!localStorage.getItem(STORAGE_KEY)) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ routines: state.routines, completions: state.completions })); }
      catch (error) { showToast(`Your empty tracker could not be saved: ${error.message}`); }
    }
    render();
    try {
      state.database = await openDatabase();
      if (!state.database) return;
      const saved = await readDatabase(state.database);
      if (saved && validState(saved)) {
        state.routines = saved.routines;
        state.completions = saved.completions;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (error) { showToast(`Local cache update failed: ${error.message}`); }
        render();
      } else if (!localStorage.getItem(STORAGE_KEY)) {
        await saveDatabase();
      } else {
        await saveDatabase();
      }
    } catch (error) {
      showToast(`IndexedDB is unavailable; using browser storage instead. ${error.message}`);
    }
  }

  function isScheduled(routine, date) {
    if (date < parseDate(routine.createdAt || today())) return false;
    if (routine.frequency === 'specific') return Array.isArray(routine.days) && routine.days.includes(date.getDay());
    return true;
  }

  function eligibleToday(routine) {
    if (isScheduled(routine, new Date())) return true;
    if (routine.frequency === 'weekly') return sameWeek(new Date(), parseDate(today()));
    return false;
  }

  function isCompleted(routine, key) {
    return Boolean(state.completions[key] && state.completions[key][routine.id]);
  }

  function completionRatio(routine, from, to) {
    let scheduled = 0;
    let completed = 0;
    for (let date = new Date(from); date <= to; date = shiftDate(date, 1)) {
      const key = dateKey(date);
      if (isScheduled(routine, date)) {
        scheduled += 1;
        if (isCompleted(routine, key)) completed += 1;
      }
    }
    return { scheduled, completed };
  }

  function periodStats(from, to) {
    let completed = 0;
    let target = 0;
    state.routines.forEach((routine) => {
      const stats = completionRatio(routine, from, to);
      if (routine.frequency === 'weekly') {
        const weeks = Math.max(1, Math.ceil((to - from + 1) / (7 * 86400000)));
        target += Math.min(stats.scheduled, Number(routine.weeklyTarget || 3) * weeks);
      } else target += stats.scheduled;
      completed += stats.completed;
    });
    return { completed, target, percent: target ? Math.round(completed / target * 100) : 0 };
  }

  function streakStats(routine) {
    const todayDate = parseDate(today());
    if (routine.frequency === 'weekly') {
      const weekStart = startOfWeek(todayDate);
      let current = 0;
      let checkWeek = new Date(weekStart);
      let currentWeekCompletions = completionRatio(routine, weekStart, todayDate).completed;
      if (currentWeekCompletions >= Number(routine.weeklyTarget || 3)) {
        current = 1;
        checkWeek = shiftDate(weekStart, -7);
      } else {
        checkWeek = shiftDate(weekStart, -7);
      }
      for (let guard = 0; guard < 520; guard += 1) {
        const end = shiftDate(checkWeek, 6);
        if (completionRatio(routine, checkWeek, end).completed < Number(routine.weeklyTarget || 3)) break;
        current += 1;
        checkWeek = shiftDate(checkWeek, -7);
      }
      let longest = current;
      let run = 0;
      let week = startOfWeek(parseDate(routine.createdAt || today()));
      for (let guard = 0; guard < 520 && week <= weekStart; guard += 1) {
        const end = shiftDate(week, 6);
        if (completionRatio(routine, week, end).completed >= Number(routine.weeklyTarget || 3)) { run += 1; longest = Math.max(longest, run); }
        else run = 0;
        week = shiftDate(week, 7);
      }
      return { current, longest, unit: 'weeks', broken: !current && completionRatio(routine, shiftDate(weekStart, -7), shiftDate(weekStart, -1)).completed < Number(routine.weeklyTarget || 3) };
    }
    const dueDates = [];
    for (let date = shiftDate(todayDate, -365); date <= todayDate; date = shiftDate(date, 1)) if (isScheduled(routine, date)) dueDates.push(date);
    let current = 0;
    for (let i = dueDates.length - 1; i >= 0; i -= 1) {
      const key = dateKey(dueDates[i]);
      if (key === today() && !isCompleted(routine, key)) continue;
      if (!isCompleted(routine, key)) break;
      current += 1;
    }
    let longest = 0;
    let run = 0;
    dueDates.forEach((date) => {
      if (isCompleted(routine, dateKey(date))) { run += 1; longest = Math.max(longest, run); } else run = 0;
    });
    const mostRecentDue = dueDates[dueDates.length - 1];
    const missed = Boolean(mostRecentDue && dateKey(mostRecentDue) !== today() && !isCompleted(routine, dateKey(mostRecentDue)));
    return { current, longest, unit: 'days', broken: missed && current === 0 };
  }

  function renderProgress() {
    const routines = state.routines.filter(eligibleToday);
    const done = routines.filter((routine) => isCompleted(routine, today())).length;
    const percentage = routines.length ? Math.round(done / routines.length * 100) : 0;
    $('#progress-percent').textContent = `${percentage}%`;
    $('#progress-count').textContent = `${done} of ${routines.length} routines`;
    $('#progress-message').textContent = percentage === 100 && routines.length ? 'Beautifully done. You showed up.' : done ? 'You’re building lovely momentum.' : 'Your first win is waiting.';
    $('#progress-ring').style.setProperty('--progress', `${percentage * 3.6}deg`);
    $('#progress-ring').setAttribute('aria-label', `${percentage}% complete`);
    $('#progress-bar').style.width = `${percentage}%`;

    const week = startOfWeek(new Date());
    const weekEnd = shiftDate(week, 6);
    const weekly = periodStats(week, weekEnd);
    $('#weekly-percent').textContent = `${weekly.percent}%`;
    $('#weekly-caption').textContent = `${weekly.completed} routine${weekly.completed === 1 ? '' : 's'} completed`;
    $('#week-bars').innerHTML = Array.from({ length: 7 }, (_, index) => {
      const date = shiftDate(week, index);
      const dayRoutines = state.routines.filter((routine) => isScheduled(routine, date));
      const completed = dayRoutines.filter((routine) => isCompleted(routine, dateKey(date))).length;
      const height = dayRoutines.length ? Math.max(7, Math.round(completed / dayRoutines.length * 100)) : 3;
      const classes = `${dateKey(date) === today() ? 'today' : ''} ${date > new Date() ? 'future' : ''}`;
      return `<div class="week-bar ${classes}" title="${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${completed}/${dayRoutines.length}"><span style="height:${height}%"></span></div>`;
    }).join('');
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const monthly = periodStats(monthStart, new Date());
    $('#welcome-copy').textContent = `${monthly.percent}% of your monthly plan is complete. A little progress adds up.`;

    const streaks = state.routines.map(streakStats);
    const best = streaks.reduce((max, streak) => streak.longest > max.longest ? streak : max, { current: 0, longest: 0, unit: 'days', broken: false });
    $('#longest-streak').textContent = best.longest;
    $('#streak-unit').textContent = best.unit;
    const active = streaks.filter((streak) => streak.current > 0).sort((a, b) => b.current - a.current)[0];
    const brokenCount = streaks.filter((streak) => streak.broken).length;
    $('#current-streak-copy').textContent = active ? `${active.current} ${active.unit} current streak${brokenCount ? ` · ${brokenCount} broken` : ''}` : brokenCount ? `${brokenCount} routine${brokenCount === 1 ? '' : 's'} with a broken streak` : 'Complete a routine to begin your streak';
  }

  function renderRoutines() {
    const routines = state.routines.filter(eligibleToday);
    $('#routine-total').textContent = routines.length;
    $('#empty-state').hidden = routines.length > 0;
    $('#routine-list').innerHTML = routines.map((routine) => {
      const style = categories[routine.category] || categories.Personal;
      const done = isCompleted(routine, today());
      const streak = streakStats(routine);
      const time = routine.startTime ? new Date(`2000-01-01T${routine.startTime}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : routine.block;
      const details = [routine.block, time].filter((item, index, values) => item !== 'Anytime' && (index === 0 || item !== values[0]));
      const cadence = routine.frequency === 'specific' ? (routine.days || []).map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') : routine.frequency === 'weekly' ? `${routine.weeklyTarget || 3}× per week` : 'Every day';
      const schedule = details.length ? details.join(' · ') : 'Anytime';
      return `<article class="routine-item ${done ? 'is-complete' : ''}">
        <button class="check-button ${done ? 'checked' : ''}" data-action="toggle" data-id="${escapeHtml(routine.id)}" type="button" aria-label="${done ? 'Mark incomplete' : 'Mark complete'}: ${escapeHtml(routine.name)}" aria-pressed="${done}">${done ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.2 3 3 6-6.2"/></svg>' : ''}</button>
        <div class="routine-emoji" style="background:${style.color};color:${style.ink}">${style.emoji}</div>
        <div class="routine-copy"><h3>${escapeHtml(routine.name)}</h3><div class="routine-meta"><span class="category-tag" style="background:${style.color};color:${style.ink}">${escapeHtml(routine.category)}</span><span class="meta-dot">·</span><span>${escapeHtml(schedule)}</span><span class="meta-dot">·</span><span>${escapeHtml(cadence)}</span></div></div>
        <div class="routine-side"><span class="routine-status ${done ? 'done' : ''}">${done ? 'Completed' : streak.current ? `✦ ${streak.current} ${streak.unit}` : 'Up next'}</span><button class="routine-menu" data-action="edit" data-id="${escapeHtml(routine.id)}" type="button" aria-label="Edit ${escapeHtml(routine.name)}">···</button></div>
      </article>`;
    }).join('');
  }

  function renderHeatmap() {
    const grid = $('#heatmap-grid');
    grid.innerHTML = '';
    const end = parseDate(today());
    const first = shiftDate(end, -364);
    const gridStart = shiftDate(first, -((first.getDay() + 6) % 7));
    const totalDays = {};
    for (let date = new Date(first); date <= end; date = shiftDate(date, 1)) {
      const key = dateKey(date);
      const scheduled = state.routines.filter((routine) => isScheduled(routine, date));
      totalDays[key] = scheduled.length ? scheduled.filter((routine) => isCompleted(routine, key)).length / scheduled.length : 0;
    }
    let activeDays = 0;
    for (let date = new Date(gridStart); date <= end; date = shiftDate(date, 1)) {
      const key = dateKey(date);
      const inRange = date >= first;
      const ratio = totalDays[key] || 0;
      const cell = document.createElement('span');
      cell.className = `heat-cell ${inRange ? `level-${ratio === 0 ? 0 : ratio < .26 ? 1 : ratio < .51 ? 2 : ratio < .76 ? 3 : 4}` : 'empty'}`;
      if (ratio > 0 && inRange) activeDays += 1;
      cell.title = inRange ? `${date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}: ${Math.round(ratio * 100)}% complete` : '';
      cell.setAttribute('aria-label', cell.title || 'Outside the last year');
      grid.appendChild(cell);
    }
    const months = $('#heatmap-months');
    months.innerHTML = '';
    const weeks = Math.ceil(grid.children.length / 7);
    months.style.width = `${weeks * 14}px`;
    for (let date = new Date(gridStart); date <= end; date = shiftDate(date, 1)) {
      if (date.getDate() === 1 || dateKey(date) === dateKey(gridStart)) {
        const label = document.createElement('span');
        label.className = 'heatmap-month';
        label.style.left = `${Math.floor(((date - gridStart) / 86400000) / 7) * 14}px`;
        label.textContent = date.toLocaleDateString(undefined, { month: 'short' });
        months.appendChild(label);
      }
    }
    grid.style.gridTemplateColumns = `repeat(${weeks}, 11px)`;
    grid.parentElement.style.width = `${weeks * 14}px`;
    $('#heatmap-total').textContent = `${activeDays} active day${activeDays === 1 ? '' : 's'} in the last year`;
  }

  function render() {
    renderProgress();
    renderRoutines();
    renderHeatmap();
    $('#top-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  function openRoutineDialog(routine) {
    state.editingId = routine ? routine.id : null;
    const form = $('#routine-form');
    form.reset();
    $('#form-error').textContent = '';
    $('#dialog-title').textContent = routine ? 'Edit routine' : 'Add a routine';
    $('#delete-routine-button').hidden = !routine;
    if (routine) {
      form.elements.name.value = routine.name;
      form.elements.category.value = routine.category;
      form.elements.block.value = routine.block;
      form.elements.frequency.value = routine.frequency;
      form.elements.weeklyTarget.value = String(routine.weeklyTarget || 3);
      form.elements.startTime.value = routine.startTime || '';
      form.elements.endTime.value = routine.endTime || '';
      form.querySelectorAll('input[name="days"]').forEach((input) => { input.checked = (routine.days || []).includes(Number(input.value)); });
    }
    updateFrequencyFields();
    $('#routine-dialog').showModal();
    $('#routine-name').focus();
  }

  function updateFrequencyFields() {
    const frequency = $('#routine-frequency').value;
    $('#days-field').hidden = frequency !== 'specific';
    $('#weekly-target-group').hidden = frequency !== 'weekly';
  }

  async function submitRoutine(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const frequency = values.get('frequency');
    const days = values.getAll('days').map(Number);
    if (frequency === 'specific' && !days.length) { $('#form-error').textContent = 'Choose at least one day for this routine.'; return; }
    const startTime = values.get('startTime');
    const endTime = values.get('endTime');
    if (startTime && endTime && endTime <= startTime) { $('#form-error').textContent = 'End time must be later than start time.'; return; }
    const existing = state.routines.find((routine) => routine.id === state.editingId);
    const routine = {
      id: existing ? existing.id : `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(values.get('name')).trim(),
      category: values.get('category'),
      block: values.get('block'),
      frequency,
      days: frequency === 'specific' ? days : [],
      weeklyTarget: Number(values.get('weeklyTarget') || 3),
      startTime: String(startTime || ''),
      endTime: String(endTime || ''),
      createdAt: existing ? existing.createdAt : today()
    };
    if (!routine.name) { $('#form-error').textContent = 'Give your routine a name.'; return; }
    if (existing) state.routines = state.routines.map((item) => item.id === existing.id ? routine : item);
    else state.routines.push(routine);
    try { await persist(); } catch { return; }
    $('#routine-dialog').close();
    render();
    showToast(existing ? 'Routine updated.' : 'Routine added. You’ve got this!');
  }

  async function toggleRoutine(id) {
    if (!state.completions[today()]) state.completions[today()] = {};
    const completed = !state.completions[today()][id];
    if (completed) state.completions[today()][id] = true;
    else delete state.completions[today()][id];
    try { await persist(); } catch { return; }
    render();
    const routine = state.routines.find((item) => item.id === id);
    showToast(completed ? `${routine.name} — nicely done!` : 'Routine marked as incomplete.');
  }

  async function deleteRoutine() {
    const routine = state.routines.find((item) => item.id === state.editingId);
    if (!routine || !window.confirm(`Delete "${routine.name}"? Its completion history will also be removed.`)) return;
    state.routines = state.routines.filter((item) => item.id !== routine.id);
    Object.values(state.completions).forEach((day) => { delete day[routine.id]; });
    try { await persist(); } catch { return; }
    $('#routine-dialog').close();
    render();
    showToast('Routine deleted.');
  }

  function exportData() {
    const payload = { version: 1, exportedAt: new Date().toISOString(), routines: state.routines, completions: state.completions };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `daymark-backup-${today()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Your data has been exported.');
  }

  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!validState(data)) throw new Error('That file does not contain valid Daymark data.');
      if (!window.confirm(`Import ${data.routines.length} routines and their completion history? This replaces current data.`)) return;
      state.routines = data.routines;
      state.completions = data.completions;
      await persist();
      render();
      showToast('Your tracker data has been imported.');
    } catch (error) {
      showToast(`Import failed: ${error.message}`);
    } finally {
      $('#import-file').value = '';
    }
  }

  $('#add-routine-button').addEventListener('click', () => openRoutineDialog(null));
  $('#empty-add-button').addEventListener('click', () => openRoutineDialog(null));
  $('#manage-button').addEventListener('click', () => openRoutineDialog(null));
  $('#routine-form').addEventListener('submit', submitRoutine);
  $('#routine-frequency').addEventListener('change', updateFrequencyFields);
  $('#delete-routine-button').addEventListener('click', deleteRoutine);
  document.querySelectorAll('.dialog-close,.dialog-cancel').forEach((button) => button.addEventListener('click', () => $('#routine-dialog').close()));
  $('#routine-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const routine = state.routines.find((item) => item.id === button.dataset.id);
    if (!routine) return;
    if (button.dataset.action === 'toggle') toggleRoutine(routine.id);
    else openRoutineDialog(routine);
  });
  $('#export-button').addEventListener('click', exportData);
  $('#import-button').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (event) => { if (event.target.files[0]) importData(event.target.files[0]); });
  $('#theme-toggle').addEventListener('click', () => {
    const dark = document.body.classList.toggle('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    $('#theme-icon').textContent = dark ? '☀' : '☾';
    $('#theme-label').textContent = dark ? 'Light appearance' : 'Dark appearance';
  });
  document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  }));
  if (localStorage.getItem(THEME_KEY) === 'dark') { document.body.classList.add('dark'); $('#theme-icon').textContent = '☀'; $('#theme-label').textContent = 'Light appearance'; }

  initialize();
  window.setInterval(() => {
    if (dateKey(new Date()) !== state.lastRenderedDate) { state.lastRenderedDate = today(); render(); }
  }, 60000);
})();
