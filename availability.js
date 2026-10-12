/*!
 * Sensibiliseringscampagne orgaandonatie – availability.js (deelnemerspagina)
 * ------------------------------------------------------------------
 * Stap 1  Gegevens (naam + periode) met validatie
 * Stap 2  Per dag een doorlopende tijdlijn van 00:00 tot 24:00 (per minuut)
 *         - penseel: Fysiek / Alleen online / Wissen
 *         - muis: klikken = blok van 15 min, slepen = exact bereik (per minuut)
 *         - touch: horizontaal slepen, óf tik begin + tik einde (exacte minuut)
 *         - exact instellen: dialoog met schuiflijnen per minuut
 *         - snelfuncties, kopiëren, "zelfde tijdvak op meerdere dagen", ongedaan maken
 * Stap 3  Samenvatting → download JSON (en optioneel indienen via config.submitEndpoint)
 *
 * Concept wordt automatisch bewaard in localStorage; bij terugkeer wordt eerst
 * gevraagd of het om dezelfde persoon gaat (gedeelde toestellen).
 *
 * Conventie: in deze code is een "slot" één minuut (core.SLOT_MINUTES = 1).
 * Een bereik [lo, hi) is exclusief aan het einde, net als in het bestand.
 */
(function () {
  'use strict';

  var core = window.Orgaandonatie.core;
  var ui = window.Orgaandonatie.ui;
  var cfg = window.Orgaandonatie.config || {};
  var el = ui.el, icon = ui.icon;
  var S = core.STATUS, N = core.SLOTS_PER_DAY;   // N = 1440 minuten per dag

  var DRAFT_KEY = 'orgaandonatie.planning.draft.v1';
  var PREFS_KEY = 'orgaandonatie.planning.prefs.v1';
  var NIGHT_END = 360;           // 06:00 in minuten sinds middernacht
  var BLOCK_SNAP = 15;           // een klik zonder slepen kiest een blok van 15 minuten
  var HISTORY_LIMIT = 100;
  var DRAG_PX = 4;               // muis: minder beweging dan dit telt als klik
  var TOUCH_X = 8, TOUCH_Y = 10; // touch: horizontaal = slepen, verticaal = scrollen
  var BRUSH_LABEL = { 0: 'Clear', 1: 'On-site', 2: 'Online only' };

  var state = freshState();
  var brush = S.PHYSICAL;
  var undoStack = [], redoStack = [];
  var views = {};                // datum → { card, track, statsEl, chipsEl, blocked, from, to }
  var drag = null;               // actieve sleepactie
  var pendingTap = null;         // touch: eerste tik ({date, m})
  var lastClick = null;          // voor Shift+klik ({date, m})
  var previewEl = null;          // het voorbeeld-element van de huidige selectie
  var lockedPeriod = null;       // {start,end} uit de uitnodigingslink
  var prefs = ui.storage.get(PREFS_KEY) || {};
  var tip;
  var lastRange = { from: 540, to: 1020 }; // 09:00 – 17:00

  function freshState() {
    return { firstName: '', lastName: '', start: '', end: '', dates: [], slots: {}, step: 1, completed: false };
  }
  function $(id) { return document.getElementById(id); }

  /* =====================================================================
   * Initialisatie
   * ===================================================================== */
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    tip = ui.floatTip();
    readUrlPeriod();
    bindStep1();
    bindStep2();
    bindStep3();
    bindDialogs();

    var draft = loadDraft();
    if (draft) {
      $('resumeName').textContent = (draft.firstName + ' ' + draft.lastName).trim() || 'onbekend';
      $('resumeWhen').textContent = 'last saved ' + relativeTime(draft.savedAt);
      $('resumeBanner').hidden = false;
      setStepIndicator(1);
      $('resumeYes').addEventListener('click', function () {
        $('resumeBanner').hidden = true;
        restoreDraft(draft);
      });
      $('resumeNo').addEventListener('click', function () {
        $('resumeBanner').hidden = true;
        wipeDraft();
        resetForm();
        showStep(1);
        ui.toast('The previous details were cleared.', { icon: 'trash' });
      });
    } else {
      showStep(1);
    }
  }

  function readUrlPeriod() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var s = params.get('start'), e2 = params.get('end');
    if (core.isValidISODate(s) && core.isValidISODate(e2) && core.diffDays(s, e2) >= 0 &&
      core.diffDays(s, e2) + 1 <= core.MAX_PERIOD_DAYS) {
      lockedPeriod = { start: s, end: e2 };
      $('startDate').value = s; $('endDate').value = e2;
      $('startDate').readOnly = true; $('endDate').readOnly = true;
      $('periodLocked').hidden = false;
      $('periodQuick').hidden = true;
    }
  }

  /* =====================================================================
   * Stappen
   * ===================================================================== */
  function setStepIndicator(n) {
    document.querySelectorAll('#steps li').forEach(function (li) {
      var s = +li.dataset.step;
      li.classList.toggle('done', s < n);
      if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  function showStep(n) {
    state.step = n;
    ['step1', 'step2', 'step3'].forEach(function (id, i) { $(id).hidden = (i + 1 !== n); });
    setStepIndicator(n);
    if (n === 1) updatePeriodInfo();
    if (n === 2) buildPlanner();
    if (n === 3) renderReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (n >= 2) saveDraft();
  }

  /* =====================================================================
   * STAP 1 – gegevens
   * ===================================================================== */
  function bindStep1() {
    var form = $('detailsForm');
    form.addEventListener('submit', function (e) { e.preventDefault(); submitStep1(); });
    ['firstName', 'lastName', 'startDate', 'endDate'].forEach(function (id) {
      $(id).addEventListener('input', function () { setFieldError(id, ''); updatePeriodInfo(); });
    });
    document.querySelectorAll('[data-quick]').forEach(function (b) {
      b.addEventListener('click', function () { quickPeriod(b.dataset.quick); });
    });
    $('importFile').addEventListener('change', importOwnFile);
  }

  function quickPeriod(kind) {
    var today = core.todayBrussels();
    var wd = core.isoWeekday(today);
    var start, end;
    if (kind === 'thisweek') { start = today; end = core.addDays(today, 7 - wd); }
    else if (kind === 'nextweek') { start = core.addDays(today, 8 - wd); end = core.addDays(start, 6); }
    else { start = today; end = core.addDays(today, 13); }
    $('startDate').value = start; $('endDate').value = end;
    setFieldError('startDate', ''); setFieldError('endDate', '');
    updatePeriodInfo();
  }

  function updatePeriodInfo() {
    var s = $('startDate').value, e = $('endDate').value, info = $('periodInfo');
    if (core.isValidISODate(s) && core.isValidISODate(e) && core.diffDays(s, e) >= 0) {
      var n = core.diffDays(s, e) + 1;
      info.textContent = n + (n === 1 ? ' day' : ' days') + ' · ' + core.formatDateShort(s) + ' to ' + core.formatDateShort(e) + ' ' + core.parseISODate(e).y;
    } else info.textContent = '';
  }

  function setFieldError(id, msg) {
    var input = $(id), err = $(id + '-err');
    if (err) err.textContent = msg;
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }

  function validateStep1() {
    var errors = {};
    var fn = core.cleanName($('firstName').value), ln = core.cleanName($('lastName').value);
    var s = $('startDate').value, e = $('endDate').value;
    if (!fn) errors.firstName = 'Enter your first name.';
    if (!ln) errors.lastName = 'Enter your last name.';
    if (!s) errors.startDate = 'Choose a start date.';
    else if (!core.isValidISODate(s)) errors.startDate = 'Invalid date.';
    if (!e) errors.endDate = 'Choose an end date.';
    else if (!core.isValidISODate(e)) errors.endDate = 'Invalid date.';
    if (!errors.startDate && !errors.endDate) {
      var n = core.diffDays(s, e) + 1;
      var today = core.todayBrussels();
      if (n < 1) errors.endDate = 'The end date is before the start date.';
      else if (n > core.MAX_PERIOD_DAYS) errors.endDate = 'The period is too long (' + n + ' days). Choose at most ' + core.MAX_PERIOD_DAYS + ' days.';
      else if (e < today) errors.endDate = 'This period is entirely in the past.';
      else if (core.diffDays(today, s) > 400) errors.startDate = 'The start date is more than a year in the future.';
    }
    return { errors: errors, firstName: fn, lastName: ln, start: s, end: e };
  }

  function submitStep1() {
    var v = validateStep1();
    var ids = ['firstName', 'lastName', 'startDate', 'endDate'];
    ids.forEach(function (id) { setFieldError(id, v.errors[id] || ''); });
    var firstBad = ids.filter(function (id) { return v.errors[id]; })[0];
    if (firstBad) { $(firstBad).focus(); return; }

    var newDates = core.dateRange(v.start, v.end);
    var lost = state.dates.filter(function (d) { return newDates.indexOf(d) < 0 && dayHasData(d); });
    var proceed = lost.length
      ? ui.confirmDialog({
        title: 'Change period?',
        body: lost.length + (lost.length === 1 ? ' day' : ' days') + ' with availability entered ' + (lost.length === 1 ? 'falls' : 'fall') +
          ' outside the new period and ' + (lost.length === 1 ? 'is' : 'are') + ' removed.',
        okText: 'Change period', danger: true
      })
      : Promise.resolve(true);
    proceed.then(function (okay) {
      if (!okay) return;
      if (lost.length) pushHistory();
      applyDetails(v.firstName, v.lastName, v.start, v.end);
      state.completed = false;
      showStep(2);
    });
  }

  function applyDetails(fn, ln, start, end) {
    state.firstName = fn; state.lastName = ln;
    state.start = start; state.end = end;
    state.dates = core.dateRange(start, end);
    var slots = {};
    state.dates.forEach(function (d) {
      var arr = state.slots[d] ? new Uint8Array(state.slots[d]) : core.emptyDay();
      var b = core.blockedSlots(d);
      for (var i = 0; i < N; i++) if (b[i]) arr[i] = S.UNAVAILABLE;
      slots[d] = arr;
    });
    state.slots = slots;
  }

  function resetForm() {
    state = freshState();
    undoStack = []; redoStack = [];
    $('detailsForm').reset();
    if (lockedPeriod) { $('startDate').value = lockedPeriod.start; $('endDate').value = lockedPeriod.end; }
    updateUndoButtons();
  }

  /** Eigen, eerder gedownload bestand opnieuw openen om aan te passen. */
  function importOwnFile(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > core.MAX_FILE_BYTES) { ui.toast('This file is too large.', { icon: 'alert' }); return; }
    file.text().then(function (text) {
      var res = core.parseAndValidate(text);
      if (!res.ok) {
        ui.confirmDialog({ title: 'The file cannot be opened', body: res.errors.join(' '), okText: 'OK' });
        return;
      }
      var d = res.data;
      if (core.diffDays(d.start, d.end) + 1 > core.MAX_PERIOD_DAYS) {
        ui.confirmDialog({ title: 'Period too long', body: 'This file covers more than ' + core.MAX_PERIOD_DAYS + ' days and cannot be edited here.', okText: 'OK' });
        return;
      }
      $('firstName').value = d.firstName; $('lastName').value = d.lastName;
      if (!lockedPeriod) { $('startDate').value = d.start; $('endDate').value = d.end; }
      state.slots = {};
      d.covered.forEach(function (iso) { state.slots[iso] = new Uint8Array(d.slots[iso]); });
      var start = lockedPeriod ? lockedPeriod.start : d.start, end = lockedPeriod ? lockedPeriod.end : d.end;
      applyDetails(d.firstName, d.lastName, start, end);
      undoStack = []; redoStack = []; updateUndoButtons();
      state.completed = false;
      ui.toast('File of ' + d.fullName + ' opened.', { icon: 'file' });
      showStep(2);
    }).catch(function () { ui.toast('The file could not be read.', { icon: 'alert' }); });
  }

  /* =====================================================================
   * STAP 2 – tijdlijnen (per minuut)
   * ===================================================================== */
  function bindStep2() {
    document.querySelectorAll('.brush button').forEach(function (b) {
      b.addEventListener('click', function () { setBrush(+b.dataset.brush); });
    });
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('backTo1').addEventListener('click', function () { fillStep1Form(); showStep(1); });
    $('toReview').addEventListener('click', function () { cancelPending(); showStep(3); });
    $('bulkFillBtn').addEventListener('click', function () { openRangeDialog(null); });
    $('clearAllBtn').addEventListener('click', function () {
      if (!state.dates.some(dayHasData)) { ui.toast('Nothing has been entered yet.', { icon: 'info' }); return; }
      ui.confirmDialog({ title: 'Clear everything?', body: 'All availability in this period will be cleared. You can undo this.', okText: 'Clear all', danger: true })
        .then(function (okay) {
          if (!okay) return;
          pushHistory();
          state.dates.forEach(function (d) { state.slots[d] = core.emptyDay(); });
          renderAllDays(); saveDraft();
          ui.toast('Everything cleared.', { icon: 'trash', actionLabel: 'Undo', onAction: undo });
        });
    });
    $('hideNight').checked = !!prefs.hideNight;
    $('hideNight').addEventListener('change', function () {
      prefs.hideNight = this.checked; ui.storage.set(PREFS_KEY, prefs);
      buildPlanner();
    });

    var list = $('dayList');
    list.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    list.addEventListener('pointerleave', function (e) { if (!drag && e.pointerType === 'mouse') tip.hide(); });
    list.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('.ctl-track')) e.preventDefault(); });

    document.addEventListener('keydown', onKeyDown);
  }

  function fillStep1Form() {
    $('firstName').value = state.firstName; $('lastName').value = state.lastName;
    if (!lockedPeriod) { $('startDate').value = state.start; $('endDate').value = state.end; }
  }

  function setBrush(v) {
    brush = v;
    document.querySelectorAll('.brush button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(+b.dataset.brush === v));
    });
    if (pendingTap) previewMark(pendingTap.date, pendingTap.m);
  }

  function isCoarse() { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }

  /** Zichtbaar bereik in minuten: hele dag, of 06:00–24:00 bij "nachturen verbergen". */
  function viewRange() {
    return $('hideNight').checked ? [NIGHT_END, N] : [0, N];
  }

  function buildPlanner() {
    cancelPending();
    var list = $('dayList');
    ui.clear(list);
    views = {};
    state.dates.forEach(function (d, idx) { list.appendChild(createDayCard(d, idx)); renderDay(d); });
    $('plannerHintText').textContent = isCoarse()
      ? 'Drag horizontally along a timeline with your finger, or tap once at the start and once at the end of a time range. For an exact time, use + Time range.'
      : 'Choose On-site, Online or Clear and drag along a timeline; the range is exact down to the minute. One click sets or clears a block of 15 minutes. Shift+click extends from your previous click.';
    updateUndoButtons();
  }

  function createDayCard(date, idx) {
    var wd = core.isoWeekday(date);
    var card = el('section', { class: 'day-card' + (wd >= 6 ? ' weekend' : ''), dataset: { date: date }, attrs: { 'aria-label': core.formatDateLong(date) } });
    var statsEl = el('div', { class: 'day-stats' });

    var moreMenu = el('details', { class: 'menu' }, [
      el('summary', { class: 'btn btn-ghost btn-sm', attrs: { 'aria-label': 'More actions for ' + core.formatDateLong(date) } }, [icon('more'), el('span', { class: 'long', text: 'Whole day' })]),
      el('div', { class: 'menu-pop', attrs: { role: 'menu' } }, [
        menuItem('Whole day on-site', 'user', function () { fillDay(date, S.PHYSICAL); }),
        menuItem('Whole day online', 'laptop', function () { fillDay(date, S.ONLINE); }),
        menuItem('Clear day', 'eraser', function () { fillDay(date, S.UNAVAILABLE); })
      ])
    ]);

    var head = el('div', { class: 'day-head' }, [
      el('div', { class: 'day-title' }, [el('h3', { text: core.formatDateLong(date) }), statsEl]),
      el('div', { class: 'day-actions' }, [
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Add a time range with exact start and end times', onclick: function () { openRangeDialog(date); } }, [icon('plus'), 'Time range']),
        idx > 0 ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: 'Copy the entries of ' + core.formatDateShort(state.dates[idx - 1]) + ' to this day', onclick: function () { copyPrevious(date); } }, [icon('copy'), 'Copy previous day']) : null,
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { openCopyDialog(date); } }, [icon('copy'), 'Copy to…']),
        moreMenu
      ])
    ]);

    var view = viewRange();
    var blocked = core.blockedSlots(date);
    var track = el('div', {
      class: 'ctl-track',
      style: { '--hours': String((view[1] - view[0]) / 60) },
      dataset: { date: date, from: String(view[0]), to: String(view[1]) },
      attrs: { role: 'group', 'aria-label': 'Timeline ' + core.slotToTime(view[0]) + ' to ' + core.slotToTime(view[1]) + '. Drag to choose a time range, or use + Time range to set exact times.' }
    });
    var tl = el('div', { class: 'ctl' }, [buildRuler(view), track]);

    var chipsEl = el('div', { class: 'day-intervals', attrs: { 'aria-live': 'polite' } });
    card.appendChild(head);
    card.appendChild(tl);
    card.appendChild(chipsEl);
    if (core.hasBlockedSlots(date)) {
      var first = -1, last = -1;
      for (var i = 0; i < N; i++) if (blocked[i]) { if (first < 0) first = i; last = i; }
      card.appendChild(el('div', { class: 'dst-note' }, [icon('clock'),
        el('span', { text: 'Clock change on this day: ' + core.slotToTime(first) + '–' + core.slotToTime(last + 1) + ' cannot be selected because that hour ' +
          (blocked[first] === core.BLOCK.NONEXISTENT ? 'does not exist' : 'occurs twice') + '.' })]));
    }
    views[date] = { card: card, track: track, statsEl: statsEl, chipsEl: chipsEl, blocked: blocked, from: view[0], to: view[1] };
    return card;
  }

  /** Uurlabels boven de tijdlijn; op kleine schermen om de paar uur. */
  function buildRuler(view) {
    var from = view[0], to = view[1], span = to - from, hours = span / 60;
    var step = isCoarse() ? (hours > 12 ? 3 : 2) : (hours > 16 ? 2 : 1);
    var ruler = el('div', { class: 'ctl-ruler', attrs: { 'aria-hidden': 'true' } });
    for (var m = Math.ceil(from / 60) * 60; m <= to; m += step * 60) {
      var cls = m === from ? 'edge-l' : (m === to ? 'edge-r' : '');
      ruler.appendChild(el('span', { class: cls, style: { left: ((m - from) / span * 100) + '%' }, text: core.slotToTime(m) }));
    }
    return ruler;
  }

  function menuItem(label, ic, fn) {
    return el('button', {
      type: 'button', class: 'menu-item', attrs: { role: 'menuitem' },
      onclick: function (e) { var d = e.currentTarget.closest('details'); if (d) d.open = false; fn(); }
    }, [icon(ic), label]);
  }

  // Sluit open menu's bij klik erbuiten
  document.addEventListener('click', function (e) {
    document.querySelectorAll('details.menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.open = false; });
  });

  function renderAllDays() { state.dates.forEach(renderDay); updateUndoButtons(); }

  /**
   * Tekent één dag opnieuw: de tijdlijn bestaat uit doorlopende segmenten
   * (één element per aaneengesloten stuk), niet uit 1440 losse blokjes.
   */
  function renderDay(date) {
    var v = views[date];
    if (!v) return;
    var arr = state.slots[date];
    var track = v.track;
    if (previewEl && track.contains(previewEl)) previewEl = null;
    ui.clear(track);

    runs(function (i) { return v.blocked[i] ? 9 : 0; }, v.from, v.to).forEach(function (r) {
      track.appendChild(segEl(r.a, r.b, 'blk', v.from, v.to));
    });
    runs(function (i) { return arr[i]; }, v.from, v.to).forEach(function (r) {
      track.appendChild(segEl(r.a, r.b, r.k === S.PHYSICAL ? 's1' : 's2', v.from, v.to));
    });

    // Statistieken
    var t = core.computeTotals({ x: arr }, ['x']);
    ui.clear(v.statsEl);
    if (t.physicalMinutes) v.statsEl.appendChild(el('span', { class: 'badge badge-physical' }, [icon('user'), core.formatDuration(t.physicalMinutes)]));
    if (t.onlineMinutes) v.statsEl.appendChild(el('span', { class: 'badge badge-online' }, [icon('laptop'), core.formatDuration(t.onlineMinutes)]));
    // Tijdvakken als chips (met verwijderknop) – ook een tekstueel, toegankelijk overzicht
    ui.clear(v.chipsEl);
    var intervals = core.slotsToIntervals(arr);
    if (!intervals.length) {
      v.chipsEl.appendChild(el('span', { class: 'empty', text: 'Unavailable. Drag along the timeline or use + Time range.' }));
      return;
    }
    intervals.forEach(function (it) {
      var phys = it.status === 'physical';
      var a = core.timeToSlot(it.start), b = core.timeToSlot(it.end, true);
      v.chipsEl.appendChild(el('span', { class: 'chip ' + (phys ? 'chip-physical' : 'chip-online') }, [
        el('span', { class: 'sw ' + (phys ? 'sw-1' : 'sw-2'), style: { width: '12px', height: '12px' } }),
        el('span', { class: 'tabular', text: it.start + '–' + it.end }),
        el('span', { text: phys ? 'On-site' : 'Online' }),
        el('button', {
          class: 'x', type: 'button', attrs: { 'aria-label': 'Remove ' + it.start + '–' + it.end + ' op ' + core.formatDateLong(date) },
          onclick: function () { setRange(date, a, b - 1, S.UNAVAILABLE); ui.toast('Time range ' + it.start + '–' + it.end + ' removed.', { icon: 'trash', actionLabel: 'Undo', onAction: undo }); }
        }, icon('x'))
      ]));
    });
  }

  /** Aaneengesloten stukken [a,b) met dezelfde sleutel (sleutel ≤ 0 = leeg). */
  function runs(keyOf, from, to) {
    var out = [], i = from;
    while (i < to) {
      var k = keyOf(i);
      if (k <= 0) { i++; continue; }
      var j = i + 1;
      while (j < to && keyOf(j) === k) j++;
      out.push({ a: i, b: j, k: k });
      i = j;
    }
    return out;
  }

  /** Positioneert een segment als percentage van de zichtbare tijdlijn. */
  function segEl(a, b, cls, from, to) {
    var span = to - from;
    return el('i', {
      class: 'seg ' + cls, attrs: { 'aria-hidden': 'true' },
      style: { left: ((a - from) / span * 100) + '%', width: ((b - a) / span * 100) + '%' }
    });
  }

  function dayHasData(d) {
    var arr = state.slots[d];
    if (!arr) return false;
    for (var i = 0; i < N; i++) if (arr[i]) return true;
    return false;
  }

  /* ---------- Bewerken ---------- */
  /** Zet minuten lo…hi (inclusief) op status. Geeft true als er iets veranderde. */
  function setRange(date, lo, hi, status, skipHistory) {
    if (hi < lo) return false;
    var arr = state.slots[date], blocked = core.blockedSlots(date);
    var changed = false;
    for (var i = lo; i <= hi; i++) if (!blocked[i] && arr[i] !== status) { changed = true; break; }
    if (!changed) return false;
    if (!skipHistory) pushHistory();
    for (var j = lo; j <= hi; j++) if (!blocked[j]) arr[j] = status;
    renderDay(date);
    saveDraft();
    return true;
  }

  /** Past een bereik [lo, hi) toe op het huidige penseel. single = een klik zonder slepen. */
  function commitRange(date, lo, hi, single) {
    var arr = state.slots[date];
    var target = brush;
    if (single && brush !== S.UNAVAILABLE && arr[lo] === brush) target = S.UNAVAILABLE; // klik op zelfde kleur = uitzetten
    var changed = setRange(date, lo, hi - 1, target);
    setLive(changed
      ? '✓ ' + core.formatSlotRange(lo, hi) + ' · ' + (target === S.UNAVAILABLE ? 'cleared' : BRUSH_LABEL[target])
      : 'No change', !!changed);
  }

  function fillDay(date, status) {
    if (setRange(date, 0, N - 1, status)) {
      ui.toast(core.formatDateShort(date) + ': ' + (status === S.PHYSICAL ? 'whole day on-site' : status === S.ONLINE ? 'whole day online' : 'cleared'),
        { icon: 'check', actionLabel: 'Undo', onAction: undo });
    }
  }

  function copyDay(src, targets) {
    pushHistory();
    targets.forEach(function (t) {
      var b = core.blockedSlots(t);
      var arr = new Uint8Array(state.slots[src]);
      for (var i = 0; i < N; i++) if (b[i]) arr[i] = S.UNAVAILABLE;
      state.slots[t] = arr;
      renderDay(t);
    });
    saveDraft();
  }

  function copyPrevious(date) {
    var idx = state.dates.indexOf(date);
    if (idx < 1) return;
    var prev = state.dates[idx - 1];
    copyDay(prev, [date]);
    ui.toast(core.formatDateShort(prev) + ' copied to ' + core.formatDateShort(date), { icon: 'copy', actionLabel: 'Undo', onAction: undo });
  }

  /* ---------- Ongedaan maken / opnieuw ---------- */
  function encodeDay(arr) { return Array.prototype.join.call(arr, ''); }
  function decodeDay(str) {
    if (typeof str !== 'string' || str.length !== N || /[^012]/.test(str)) return null;
    var arr = new Uint8Array(N);
    for (var i = 0; i < N; i++) arr[i] = str.charCodeAt(i) - 48;
    return arr;
  }
  function snapshot() {
    var o = {};
    state.dates.forEach(function (d) { o[d] = encodeDay(state.slots[d]); });
    return o;
  }
  function restore(snap) {
    state.dates.forEach(function (d) { state.slots[d] = (snap[d] && decodeDay(snap[d])) || core.emptyDay(); });
    renderAllDays(); saveDraft();
  }
  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    setLive('Undone', true);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    setLive('Redone', true);
  }
  function updateUndoButtons() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }

  /* ---------- Aanwijzer-interactie (muis, pen, touch) ---------- */

  /**
   * Minuut onder de aanwijzer op een tijdlijn.
   * 'edge'  = dichtstbijzijnde grens (0…einde): voor het begin/einde van een bereik.
   * 'floor' = de minuut waarin de aanwijzer staat: voor klikken en hover.
   */
  function minuteAt(track, clientX, mode) {
    var from = +track.dataset.from, to = +track.dataset.to;
    var r = track.getBoundingClientRect();
    var f = r.width ? (clientX - r.left) / r.width : 0;
    f = Math.min(1, Math.max(0, f));
    var x = from + f * (to - from);
    var m = mode === 'edge' ? Math.round(x) : Math.floor(x);
    var hi = mode === 'edge' ? to : to - 1;
    return Math.min(hi, Math.max(from, m));
  }

  function xOfMinute(track, m) {
    var from = +track.dataset.from, to = +track.dataset.to;
    var r = track.getBoundingClientRect();
    return r.left + (m - from) / (to - from) * r.width;
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button > 0) return;
    var track = e.target.closest && e.target.closest('.ctl-track');
    if (!track || !views[track.dataset.date]) return;
    var date = track.dataset.date, v = views[date];
    var floorM = minuteAt(track, e.clientX, 'floor');
    if (v.blocked[floorM]) { ui.toast('This moment falls within the clock change hour and cannot be chosen.', { icon: 'clock' }); return; }
    tip.hide();
    var edge = minuteAt(track, e.clientX, 'edge');

    if (e.pointerType === 'touch') {
      // Nog niet beslissen: verticaal = scrollen, horizontaal = slepen, geen beweging = tik.
      drag = { mode: 'pending', id: e.pointerId, date: date, track: track, anchor: edge, cur: edge, clickM: floorM, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    e.preventDefault();
    cancelPending();
    var shift = !!(e.shiftKey && lastClick && lastClick.date === date);
    drag = { mode: 'drag', id: e.pointerId, date: date, track: track, anchor: shift ? lastClick.m : edge, cur: edge, clickM: floorM, x: e.clientX, y: e.clientY, moved: shift };
    previewDrag(drag, e.clientX, e.clientY);
  }

  function onPointerMove(e) {
    if (!drag) {
      if (e.pointerType === 'mouse' && state.step === 2 && !pendingTap) hoverTip(e);
      return;
    }
    if (e.pointerId !== drag.id) return;
    var dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
    if (drag.mode === 'pending') {
      if (dx > TOUCH_X && dx > dy) { drag.mode = 'drag'; drag.moved = true; cancelPending(); }
      else if (dy > TOUCH_Y) { drag = null; return; }   // gebruiker scrolt
      else return;
    }
    if (!drag.moved && (dx > DRAG_PX || dy > DRAG_PX)) drag.moved = true;
    drag.cur = minuteAt(drag.track, e.clientX, 'edge');
    previewDrag(drag, e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var d = drag;
    drag = null;
    if (d.mode === 'pending') { if (!d.moved) handleTap(d.date, d.anchor); return; }
    clearPreview(); tip.hide();
    if (d.moved) {
      commitRange(d.date, Math.min(d.anchor, d.cur), Math.max(d.anchor, d.cur), false);
      lastClick = { date: d.date, m: d.cur };
    } else {
      var lo = d.clickM - (d.clickM % BLOCK_SNAP);
      var hi = Math.min(lo + BLOCK_SNAP, views[d.date].to);
      commitRange(d.date, lo, hi, true);
      lastClick = { date: d.date, m: d.clickM };
    }
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    if (!pendingTap) clearPreview();
    tip.hide();
  }

  /** Touch: eerste tik = begin, tweede tik (zelfde dag) = einde. */
  function handleTap(date, m) {
    var v = views[date];
    if (pendingTap && pendingTap.date === date) {
      var a = pendingTap.m;
      pendingTap = null;
      clearPreview(); tip.hide();
      var lo = Math.min(a, m), hi = Math.max(a, m);
      if (lo === hi) { hi = Math.min(lo + BLOCK_SNAP, v.to); }   // zelfde punt twee keer = blok van 15 min
      commitRange(date, lo, hi, false);
      lastClick = { date: date, m: m };
      return;
    }
    pendingTap = { date: date, m: m };
    previewMark(date, m);
    tip.show(xOfMinute(v.track, m), v.track.getBoundingClientRect().top, 'Start ' + core.slotToTime(m), 'Now tap the end of the time range', false);
    setLive('Start ' + core.slotToTime(m) + ': tap the end', true);
  }

  function cancelPending() {
    if (pendingTap) { pendingTap = null; setLive('Drag along the timeline', false); }
    clearPreview();
    if (tip) tip.hide();
  }

  function previewDrag(d, x, y) {
    var lo, hi;
    if (d.moved) { lo = Math.min(d.anchor, d.cur); hi = Math.max(d.anchor, d.cur); }
    else { lo = d.clickM - (d.clickM % BLOCK_SNAP); hi = Math.min(lo + BLOCK_SNAP, views[d.date].to); }
    previewRange(d.date, lo, hi, x, y);
  }

  /** Toont het voorbeeld van een bereik [lo, hi). */
  function previewRange(date, lo, hi, x, y) {
    clearPreview();
    var v = views[date];
    if (!v || hi <= lo) return;
    previewEl = segEl(lo, hi, 'pv pv-' + brush, v.from, v.to);
    v.track.appendChild(previewEl);
    var label = core.formatSlotRange(lo, hi);
    var sub = BRUSH_LABEL[brush] + ' · ' + core.formatDuration((hi - lo) * core.SLOT_MINUTES);
    setLive(label + ' · ' + BRUSH_LABEL[brush], true);
    if (x !== undefined) tip.show(x, y - (isCoarse() ? 44 : 8), label, sub, true);
  }

  /** Een losse streep op het begin- of eindpunt (touch: na de eerste tik). */
  function previewMark(date, m) {
    clearPreview();
    var v = views[date];
    if (!v) return;
    previewEl = segEl(m, Math.min(m + 1, v.to), 'pv pv-mark', v.from, v.to);
    v.track.appendChild(previewEl);
  }

  function clearPreview() {
    if (previewEl && previewEl.parentNode) previewEl.parentNode.removeChild(previewEl);
    previewEl = null;
  }

  function hoverTip(e) {
    var track = e.target.closest && e.target.closest('.ctl-track');
    if (!track || !views[track.dataset.date]) { tip.hide(); return; }
    var date = track.dataset.date, v = views[date];
    var m = minuteAt(track, e.clientX, 'floor');
    var sub = v.blocked[m] ? 'Clock change: not selectable' : core.STATUS_LABELS[state.slots[date][m]];
    tip.show(e.clientX, track.getBoundingClientRect().top, core.slotToTime(m), sub, false);
  }

  function setLive(text, active) {
    $('selectionText').textContent = text;
    $('selectionLive').classList.toggle('active', !!active);
  }

  function onKeyDown(e) {
    if (state.step !== 2) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || document.querySelector('dialog[open]')) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod || e.altKey) return;
    if (e.key === '1') setBrush(S.PHYSICAL);
    else if (e.key === '2') setBrush(S.ONLINE);
    else if (e.key === '3') setBrush(S.UNAVAILABLE);
    else if (e.key === 'Escape') { drag = null; cancelPending(); }
  }

  /* =====================================================================
   * Dialogen: exact tijdvak op meerdere dagen & kopiëren
   * ===================================================================== */
  function bindDialogs() {
    $('rdFrom').addEventListener('input', updateRangeOutputs);
    $('rdTo').addEventListener('input', updateRangeOutputs);
    $('rdCancel').addEventListener('click', function () { $('rangeDialog').close(); });
    $('cpCancel').addEventListener('click', function () { $('copyDialog').close(); });
    $('rangeForm').addEventListener('submit', applyRangeDialog);
    $('copyForm').addEventListener('submit', applyCopyDialog);
  }

  /** Toont de gekozen tijden naast de schuiflijnen (per minuut). */
  function updateRangeOutputs() {
    $('rdFromOut').textContent = core.slotToTime(+$('rdFrom').value);
    $('rdToOut').textContent = core.slotToTime(+$('rdTo').value);
  }

  function dayCheckboxes(container, name, checkedFn, excludeDate) {
    ui.clear(container);
    state.dates.forEach(function (d) {
      if (d === excludeDate) return;
      container.appendChild(el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', name: name, value: d, checked: !!checkedFn(d) }),
        el('span', { text: core.formatDateShort(d) })
      ]));
    });
  }

  function quickButtons(container, list, name) {
    ui.clear(container);
    var defs = [
      ['Alle', function () { return true; }],
      ['Werkdagen', function (d) { return core.isoWeekday(d) <= 5; }],
      ['Weekend', function (d) { return core.isoWeekday(d) >= 6; }],
      ['None', function () { return false; }]
    ].concat(list || []);
    defs.forEach(function (def) {
      container.appendChild(el('button', {
        type: 'button', class: 'btn btn-sm', text: def[0],
        onclick: function () {
          container.parentNode.querySelectorAll('input[name="' + name + '"]').forEach(function (cb) { cb.checked = def[1](cb.value); });
        }
      }));
    });
  }

  function openRangeDialog(date) {
    $('rd-title').textContent = date ? 'Add time range' : 'Same time range on several days';
    $('rdFrom').value = String(lastRange.from);
    $('rdTo').value = String(lastRange.to);
    updateRangeOutputs();
    document.querySelectorAll('input[name="rdStatus"]').forEach(function (r) { r.checked = +r.value === brush; });
    $('rdError').textContent = '';
    dayCheckboxes($('rdDays'), 'rdDay', function (d) { return date ? d === date : core.isoWeekday(d) <= 5; });
    quickButtons($('rdQuick'), null, 'rdDay');
    $('rangeDialog').showModal();
    $('rdFrom').focus();
  }

  function applyRangeDialog(e) {
    e.preventDefault();
    var a = +$('rdFrom').value, b = +$('rdTo').value;
    var status = +(document.querySelector('input[name="rdStatus"]:checked') || { value: 1 }).value;
    var days = Array.prototype.map.call(document.querySelectorAll('input[name="rdDay"]:checked'), function (cb) { return cb.value; });
    if (b <= a) { $('rdError').textContent = 'The end time must be after the start time.'; return; }
    if (!days.length) { $('rdError').textContent = 'Choose at least one day.'; return; }
    pushHistory();
    days.forEach(function (d) { setRange(d, a, b - 1, status, true); });
    lastRange = { from: a, to: b };
    $('rangeDialog').close();
    ui.toast(core.formatSlotRange(a, b) + ' · ' + BRUSH_LABEL[status] + ' op ' + days.length + (days.length === 1 ? ' day' : ' days'),
      { icon: 'check', actionLabel: 'Undo', onAction: undo });
  }

  var copySource = null;
  function openCopyDialog(date) {
    copySource = date;
    $('cp-title').textContent = 'Copy ' + core.formatDateShort(date) + ' to…';
    var iv = core.slotsToIntervals(state.slots[date]);
    $('cpInfo').textContent = iv.length
      ? 'Entries: ' + iv.map(function (x) { return x.start + '–' + x.end + ' (' + (x.status === 'physical' ? 'on-site' : 'online') + ')'; }).join(', ')
      : 'This day is empty. Copying will therefore empty the chosen days too.';
    $('cpError').textContent = '';
    var wd = core.isoWeekday(date);
    dayCheckboxes($('cpDays'), 'cpDay', function () { return false; }, date);
    quickButtons($('cpQuick'), [['Same weekday', function (d) { return core.isoWeekday(d) === wd; }]], 'cpDay');
    $('copyDialog').showModal();
  }

  function applyCopyDialog(e) {
    e.preventDefault();
    var days = Array.prototype.map.call(document.querySelectorAll('input[name="cpDay"]:checked'), function (cb) { return cb.value; });
    if (!days.length) { $('cpError').textContent = 'Choose at least one day.'; return; }
    copyDay(copySource, days);
    $('copyDialog').close();
    ui.toast(core.formatDateShort(copySource) + ' copied to ' + days.length + (days.length === 1 ? ' day' : ' days'),
      { icon: 'copy', actionLabel: 'Undo', onAction: undo });
  }

  /* =====================================================================
   * STAP 3 – controleren & indienen
   * ===================================================================== */
  function bindStep3() {
    $('backTo2').addEventListener('click', function () { showStep(2); });
    $('editAgain').addEventListener('click', function () { $('doneCard').hidden = true; $('reviewCard').hidden = false; showStep(2); });
    $('downloadBtn').addEventListener('click', doDownload);
    $('downloadAgain').addEventListener('click', doDownload);
    $('submitBtn').addEventListener('click', doSubmit);
    $('wipeBtn').addEventListener('click', function () {
      ui.confirmDialog({ title: 'Clear details?', body: 'Your name and availability will be removed from this device. Your downloaded file will remain.', okText: 'Clear', danger: true })
        .then(function (okay) {
          if (!okay) return;
          wipeDraft(); resetForm();
          $('doneCard').hidden = true; $('reviewCard').hidden = false;
          showStep(1);
          ui.toast('Your details have been cleared from this device.', { icon: 'trash' });
        });
    });
    if (cfg.submitEndpoint) { $('submitBtn').hidden = false; $('submitInfo').hidden = false; }
    else $('downloadBtn').className = 'btn btn-primary btn-lg'; // downloaden is dan de hoofdactie
  }

  function renderReview() {
    $('doneCard').hidden = true; $('reviewCard').hidden = false;
    var totals = core.computeTotals(state.slots, state.dates);
    $('rvName').textContent = state.firstName + ' ' + state.lastName;
    $('rvPeriod').textContent = core.formatPeriod(state.start, state.end);
    $('rvDays').textContent = String(state.dates.length);
    $('rvFilled').textContent = String(totals.daysWithAvailability);
    $('rvPhys').textContent = core.formatDuration(totals.physicalMinutes);
    $('rvOnline').textContent = core.formatDuration(totals.onlineMinutes);

    var warn = $('rvWarnings');
    ui.clear(warn);
    if (totals.physicalMinutes + totals.onlineMinutes === 0) {
      warn.appendChild(el('div', { class: 'alert alert-warn' }, [icon('alert'), el('div', {}, [
        el('strong', { text: 'You have not marked any availability yet. ' }),
        'Your file will then say you are unavailable for this entire period. Is that wrong? Go back to change it.'])]));
    } else {
      var empty = state.dates.length - totals.daysWithAvailability;
      if (empty > 0) {
        warn.appendChild(el('div', { class: 'alert alert-info' }, [icon('info'), el('div', {
          text: empty + (empty === 1 ? ' day is' : ' days are') + ' fully "unavailable". If that is correct, you do not need to do anything.'
        })]));
      }
    }

    var list = $('rvDaysList');
    ui.clear(list);
    state.dates.forEach(function (d) {
      var arr = state.slots[d];
      var bar = el('div', { class: 'bar', attrs: { 'aria-hidden': 'true' } });
      runs(function (i) { return arr[i]; }, 0, N).forEach(function (r) {
        bar.appendChild(el('i', {
          class: r.k === S.PHYSICAL ? 's1' : 's2',
          style: { left: (r.a / N * 100) + '%', width: ((r.b - r.a) / N * 100) + '%' }
        }));
      });
      var t = core.computeTotals({ x: arr }, ['x']);
      var txt = (t.physicalMinutes ? 'On-site ' + core.formatDuration(t.physicalMinutes) : '') +
        (t.physicalMinutes && t.onlineMinutes ? ' · ' : '') + (t.onlineMinutes ? 'Online ' + core.formatDuration(t.onlineMinutes) : '');
      var iv = core.slotsToIntervals(arr).map(function (x) { return x.start + '–' + x.end + ' ' + (x.status === 'physical' ? 'on-site' : 'online'); }).join(', ');
      list.appendChild(el('div', { class: 'mini-day', attrs: { title: iv || 'Unavailable' } }, [
        el('span', { text: core.formatDateShort(d) }), bar,
        el('span', { class: 'tot', text: txt || 'unavailable' }),
        el('span', { class: 'visually-hidden', text: iv || 'Unavailable' })
      ]));
    });
  }

  function currentDocument() {
    return core.buildDocument({ firstName: state.firstName, lastName: state.lastName, start: state.start, end: state.end, slots: state.slots });
  }

  function doDownload() {
    var doc = currentDocument();
    var filename = core.buildFilename(state.firstName, state.lastName, state.start, state.end);
    // Extra zekerheid: het document moet onze eigen validatie doorstaan.
    var check = core.validateDocument(JSON.parse(JSON.stringify(doc)));
    if (!check.ok) { ui.confirmDialog({ title: 'Something went wrong', body: check.errors.join(' '), okText: 'OK' }); return; }
    ui.downloadText(filename, JSON.stringify(doc, null, 2) + '\n');
    state.completed = true; saveDraft();
    showDone('download', filename);
  }

  function doSubmit() {
    if (!cfg.submitEndpoint) return;
    var btn = $('submitBtn');
    var doc = currentDocument();
    var filename = core.buildFilename(state.firstName, state.lastName, state.start, state.end);
    btn.disabled = true;
    var label = btn.lastChild.textContent;
    btn.lastChild.textContent = ' Submitting…';
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, 20000);
    // text/plain = "simple request": geen CORS-preflight nodig (vereist door Google Apps Script).
    fetch(cfg.submitEndpoint, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ type: 'orgaandonatie-planning-submission', filename: filename, document: doc }),
      signal: controller ? controller.signal : undefined
    }).then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || 'Unknown error');
        state.completed = true; saveDraft();
        showDone('submit', filename);
      })
      .catch(function () {
        ui.confirmDialog({
          title: 'Submitting failed',
          body: 'Your availability could not be sent (no connection, or the service is temporarily unavailable). Download the file and send it by e-mail to ' + cfg.contactEmail + '.',
          okText: 'Download file', cancelText: 'Close'
        }).then(function (okay) { if (okay) doDownload(); });
      })
      .then(function () { clearTimeout(timer); btn.disabled = false; btn.lastChild.textContent = label; });
  }

  function showDone(kind, filename) {
    $('reviewCard').hidden = true;
    var card = $('doneCard');
    card.hidden = false;
    $('doneFilename').textContent = filename;
    var email = cfg.contactEmail || '';
    var submitted = kind === 'submit';
    $('doneTitle').textContent = submitted ? 'Your availability has been submitted' : 'Your file has been downloaded';
    $('doneSteps').hidden = false;
    $('mailtoBtn').hidden = true;
    var name = state.firstName + ' ' + state.lastName;
    var subject = 'Availability ' + name + ' (' + core.formatPeriod(state.start, state.end) + ')';
    var body = 'Dear coordinator,\n\nAttached you will find my availability for ' + core.formatPeriod(state.start, state.end) +
      '.\n\nFile: ' + filename + '\n\n(Do not forget to attach the file.)\n\nKind regards,\n' + name;
    $('mailtoBtn').href = 'mailto:' + email + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    card.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* =====================================================================
   * Concept bewaren (localStorage)
   * ===================================================================== */
  function saveDraft() {
    if (!state.firstName && !state.lastName) return;
    var slots = {};
    state.dates.forEach(function (d) { slots[d] = encodeDay(state.slots[d]); });
    ui.storage.set(DRAFT_KEY, {
      v: 1, savedAt: Date.now(), step: state.step, completed: state.completed,
      firstName: state.firstName, lastName: state.lastName, start: state.start, end: state.end, slots: slots
    });
  }

  function loadDraft() {
    var d = ui.storage.get(DRAFT_KEY);
    if (!d || d.v !== 1) return null;
    var maxAge = (cfg.draftMaxAgeDays || 7) * 86400000;
    if (!d.savedAt || Date.now() - d.savedAt > maxAge ||
      !core.isValidISODate(d.start) || !core.isValidISODate(d.end) || core.diffDays(d.start, d.end) < 0 ||
      core.diffDays(d.start, d.end) + 1 > core.MAX_PERIOD_DAYS) {
      wipeDraft();
      return null;
    }
    return d;
  }

  function restoreDraft(d) {
    state = freshState();
    var slots = {};
    Object.keys(d.slots || {}).forEach(function (k) { var arr = decodeDay(d.slots[k]); if (arr && core.isValidISODate(k)) slots[k] = arr; });
    state.slots = slots;
    var start = d.start, end = d.end;
    if (lockedPeriod && (lockedPeriod.start !== d.start || lockedPeriod.end !== d.end)) {
      start = lockedPeriod.start; end = lockedPeriod.end;
      ui.toast('The period was adjusted to match your invitation link.', { icon: 'calendar' });
    }
    applyDetails(core.cleanName(d.firstName), core.cleanName(d.lastName), start, end);
    state.completed = !!d.completed;
    fillStep1Form();
    showStep(d.step === 3 ? 3 : 2);
  }

  function wipeDraft() { ui.storage.remove(DRAFT_KEY); }

  function relativeTime(ms) {
    var diff = Math.max(0, Date.now() - ms) / 60000;
    if (diff < 1) return 'just now';
    if (diff < 60) return Math.round(diff) + ' min ago';
    if (diff < 60 * 24) return Math.round(diff / 60) + ' h ago';
    return Math.round(diff / 1440) + ' days ago';
  }
})();
