/*!
 * Sensibiliseringscampagne orgaandonatie – coordinator.js (coördinatorpagina)
 * ------------------------------------------------------------------
 * - Meerdere JSON-bestanden laden (drag & drop of selecteren)
 * - Elk bestand afzonderlijk valideren; één fout bestand breekt niets
 * - Dubbele personen herkennen (nieuwste versie wint)
 * - Vergaderduur + filters → matcher.analyze → resultaten + heatmap
 *
 * PRIVACY: bestanden worden enkel met FileReader/Blob.text() in het geheugen
 * van de browser gelezen. Er is geen enkele netwerkaanvraag met deze gegevens
 * en er wordt niets in localStorage bewaard.
 */
(function () {
  'use strict';

  var core = window.Orgaandonatie.core;
  var matcher = window.Orgaandonatie.matcher;
  var ui = window.Orgaandonatie.ui;
  var el = ui.el, icon = ui.icon;
  var N = core.SLOTS_PER_DAY;

  var MAX_FILES = 60;
  var TYPE_INFO = {
    physical: { label: 'Everyone on-site', badge: 'badge-physical', icon: 'user' },
    mixed: { label: 'Everyone available: on-site or online', badge: 'badge-mixed', icon: 'users' },
    online: { label: 'Everyone online only', badge: 'badge-online', icon: 'laptop' },
    partial: { label: 'Not everyone', badge: 'badge-partial', icon: 'users' }
  };

  var participants = [];
  var searched = false;
  var lastAnalysis = null;
  var tip;

  function $(id) { return document.getElementById(id); }

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    tip = ui.floatTip();
    buildControls();
    bindFiles();
    bindInvite();
    $('searchBtn').addEventListener('click', function () { searched = true; runSearch(true); });
    $('copyResults').addEventListener('click', copyResults);
    $('removeAll').addEventListener('click', function () {
      ui.confirmDialog({ title: 'Remove all participants?', body: 'All loaded files will be removed from this page.', okText: 'Remove', danger: true })
        .then(function (okay) { if (okay) { participants = []; onParticipantsChanged(); } });
    });
    onParticipantsChanged();
  }

  /* =====================================================================
   * Bedieningselementen
   * ===================================================================== */
  function buildControls() {
    var dur = $('duration');
    for (var m = 15; m <= 240; m += 15) dur.appendChild(el('option', { value: String(m), text: core.formatMeetingDuration(m), selected: m === 60 }));

    var tf = $('timeFrom'), tt = $('timeTo');
    for (var i = 0; i < N; i += 15) tf.appendChild(el('option', { value: String(i), text: core.slotToTime(i), selected: i === 480 }));
    for (var j = 15; j <= N; j += 15) tt.appendChild(el('option', { value: String(j), text: core.slotToTime(j), selected: j === 1320 }));

    var wd = $('weekdays');
    core.WEEKDAY_NAMES.forEach(function (name, idx) {
      wd.appendChild(el('label', { class: 'check-pill' }, [
        el('input', { type: 'checkbox', value: String(idx + 1), checked: true }),
        name.charAt(0).toUpperCase() + name.slice(1)
      ]));
    });

    ['duration', 'minPeople', 'sortBy', 'dateFrom', 'dateTo', 'timeFrom', 'timeTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { if (searched) runSearch(false); });
    });
    [wd, $('types')].forEach(function (g) {
      g.addEventListener('change', function () { if (searched) runSearch(false); });
    });
  }

  function readOptions() {
    var weekdays = Array.prototype.filter.call($('weekdays').querySelectorAll('input'), function (c) { return c.checked; })
      .map(function (c) { return +c.value; });
    var types = {};
    $('types').querySelectorAll('input').forEach(function (c) { types[c.value] = c.checked; });
    return {
      durationMinutes: +$('duration').value,
      dateFrom: $('dateFrom').value || undefined,
      dateTo: $('dateTo').value || undefined,
      timeFrom: +$('timeFrom').value,
      timeTo: +$('timeTo').value,
      weekdays: weekdays,
      types: types,
      minParticipants: +$('minPeople').value || participants.length,
      sort: $('sortBy').value
    };
  }

  /* =====================================================================
   * Bestanden inlezen
   * ===================================================================== */
  function bindFiles() {
    var dz = $('dropzone'), input = $('fileInput');
    input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { if (!dz.contains(e.relatedTarget)) dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation();
      dz.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
    // Voorkom dat de browser een bestand opent als het naast de dropzone wordt losgelaten.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('clearLog').addEventListener('click', function () { ui.clear($('fileLog')); $('clearLog').hidden = true; });
    $('loadSamples').addEventListener('click', loadSamples);
  }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length > MAX_FILES) {
      logEntry('Too many files', 'err', ['Maximum ' + MAX_FILES + ' files at a time.']);
      return;
    }
    Promise.all(files.map(readOne)).then(function (items) {
      var summary = { added: 0, replaced: 0, failed: 0, skipped: 0 };
      items.forEach(function (it) { ingest(it, summary); });
      onParticipantsChanged();
      var parts = [];
      if (summary.added) parts.push(summary.added + ' loaded');
      if (summary.replaced) parts.push(summary.replaced + ' updated');
      if (summary.skipped) parts.push(summary.skipped + ' skipped');
      if (summary.failed) parts.push(summary.failed + ' with errors');
      ui.toast(parts.join(' · ') || 'No changes', { icon: summary.failed ? 'alert' : 'check' });
    });
  }

  function readOne(file) {
    var name = String(file.name || 'file').slice(0, 120);
    if (file.size > core.MAX_FILE_BYTES) return Promise.resolve({ name: name, result: { ok: false, errors: ['The file is too large (max. 2 MB).'], warnings: [] } });
    if (!/\.json$/i.test(name) && file.type && file.type.indexOf('json') < 0) {
      return Promise.resolve({ name: name, result: { ok: false, errors: ['This is not a .json file.'], warnings: [] } });
    }
    var reader = file.text ? file.text() : new Promise(function (res, rej) {
      var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file);
    });
    return reader.then(function (text) { return { name: name, result: core.parseAndValidate(text) }; },
      function () { return { name: name, result: { ok: false, errors: ['The file could not be read.'], warnings: [] } }; });
  }

  function ingest(item, summary) {
    var r = item.result;
    if (!r.ok) {
      summary.failed++;
      logEntry(item.name, 'err', r.errors);
      return;
    }
    var p = r.data;
    p.fileName = item.name;
    var warnings = r.warnings.slice();
    var idx = -1;
    for (var i = 0; i < participants.length; i++) if (participants[i].key === p.key) { idx = i; break; }
    if (idx >= 0) {
      var old = participants[idx];
      var newer = p.submittedAt && (!old.submittedAt || Date.parse(p.submittedAt) > Date.parse(old.submittedAt));
      if (newer) {
        participants[idx] = p;
        summary.replaced++;
        warnings.unshift(p.fullName + ' was already loaded. The newer version (' + formatStamp(p.submittedAt) + ') replaces the older one.');
        logEntry(item.name, 'warn', warnings, p.fullName);
      } else {
        summary.skipped++;
        logEntry(item.name, 'warn', [p.fullName + ' is already loaded with an equally recent or newer version. This file was skipped.'], p.fullName);
      }
      return;
    }
    participants.push(p);
    summary.added++;
    logEntry(item.name, warnings.length ? 'warn' : 'ok', warnings, p.fullName);
  }

  function logEntry(fileName, kind, messages, who) {
    var log = $('fileLog');
    var ic = kind === 'err' ? 'x' : kind === 'warn' ? 'alert' : 'check';
    var color = kind === 'err' ? 'var(--danger)' : kind === 'warn' ? 'var(--warning)' : 'var(--success)';
    var li = el('li', { class: kind === 'ok' ? '' : kind }, [
      el('div', { class: 'fn', attrs: { title: fileName } }, [
        el('span', { style: { color: color } }, icon(ic)),
        el('span', { class: 'fn-text' }, [
          el('span', { text: who || fileName }),
          who ? el('span', { class: 'fn-file', text: fileName }) : null
        ])
      ])
    ]);
    if (messages && messages.length) li.appendChild(el('ul', {}, messages.map(function (m) { return el('li', { text: m }); })));
    log.insertBefore(li, log.firstChild);
    while (log.children.length > 30) log.removeChild(log.lastChild);
    $('clearLog').hidden = false;
  }

  function loadSamples() {
    fetch('voorbeeldgegevens.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error();
        handleFiles(list.map(function (it) {
          return new File([JSON.stringify(it.document)], String(it.name || 'voorbeeld.json'), { type: 'application/json' });
        }));
      })
      .catch(function () {
        ui.toast('Loading sample data only works via GitHub Pages or a local web server.', { icon: 'info', duration: 5000 });
      });
  }

  /* =====================================================================
   * Deelnemers
   * ===================================================================== */
  function onParticipantsChanged() {
    participants.sort(function (a, b) { return a.fullName.localeCompare(b.fullName, 'nl', { sensitivity: 'base' }); });
    renderParticipants();
    var cov = matcher.computeCoverage(participants);
    // Datumfilters op de gemeenschappelijke periode zetten
    var df = $('dateFrom'), dt = $('dateTo');
    if (cov.commonDates.length) {
      var first = cov.commonDates[0], last = cov.commonDates[cov.commonDates.length - 1];
      df.min = dt.min = first; df.max = dt.max = last;
      if (!df.value || df.value < first || df.value > last) df.value = first;
      if (!dt.value || dt.value > last || dt.value < first) dt.value = last;
    } else { df.value = dt.value = ''; }

    buildMinPeople();
    var has = participants.length > 0;
    $('searchBtn').disabled = !has || !cov.commonDates.length;
    $('searchHint').textContent = !has ? 'Load at least one file first.'
      : !cov.commonDates.length ? 'There are no days for which everyone has data.'
        : participants.length + ' participant' + (participants.length === 1 ? '' : 's') + ' · ' + cov.commonDates.length + ' shared day' + (cov.commonDates.length === 1 ? '' : 's');
    if (!has) { searched = false; $('resultsCard').hidden = true; $('heatmapCard').hidden = true; }
    else if (searched) runSearch(false);
  }

  /** Keuzelijst "Minimaal aantal deelnemers": Iedereen (n), n-1 van n, … 1 van n. */
  function buildMinPeople() {
    var sel = $('minPeople'), n = participants.length;
    var prev = sel.dataset.chosen === 'all' || !sel.dataset.chosen ? 'all' : +sel.dataset.chosen;
    ui.clear(sel);
    if (!n) { sel.appendChild(el('option', { text: 'Everyone' })); sel.disabled = true; return; }
    sel.disabled = n < 2;
    for (var m = n; m >= 1; m--) {
      sel.appendChild(el('option', { value: String(m), text: m === n ? 'Everyone (' + n + ')' : m + ' of ' + n }));
    }
    sel.value = String(prev === 'all' || prev > n ? n : prev);
    if (!sel.onchange) sel.onchange = function () { sel.dataset.chosen = +sel.value === participants.length ? 'all' : sel.value; };
  }

  function renderParticipants() {
    var list = $('peopleList');
    ui.clear(list);
    var n = participants.length;
    $('peopleCount').textContent = n ? n + (n === 1 ? ' participant loaded' : ' participants loaded') : 'No participants loaded yet';
    $('removeAll').hidden = n < 2;
    participants.forEach(function (p) {
      var meta = core.formatPeriod(p.start, p.end) + ' · On-site ' + core.formatDuration(p.totals.physicalMinutes) + ' · Online ' + core.formatDuration(p.totals.onlineMinutes);
      list.appendChild(el('li', { class: 'person' }, [
        el('span', { class: 'ok', attrs: { 'aria-hidden': 'true' } }, icon('check')),
        el('div', {}, [el('div', { class: 'nm', text: p.fullName }), el('div', { class: 'meta', text: meta, title: p.fileName || '' })]),
        el('button', {
          class: 'btn btn-ghost btn-icon btn-sm', type: 'button', attrs: { 'aria-label': 'Remove ' + p.fullName, title: 'Remove' },
          onclick: function () {
            participants = participants.filter(function (x) { return x !== p; });
            onParticipantsChanged();
            ui.toast(p.fullName + ' removed', { icon: 'trash', actionLabel: 'Undo', onAction: function () { participants.push(p); onParticipantsChanged(); } });
          }
        }, icon('x'))
      ]));
    });

    var box = $('commonPeriod');
    ui.clear(box);
    if (!n) { box.hidden = true; return; }
    box.hidden = false;
    var cov = matcher.computeCoverage(participants);
    if (!cov.commonDates.length) {
      box.appendChild(el('div', { class: 'alert alert-error', style: { padding: '10px 12px' } }, [icon('alert'),
        el('div', { text: 'The participants\' periods do not overlap. There is no day for which everyone has data.' })]));
      return;
    }
    box.appendChild(el('div', {}, [el('strong', { text: 'Shared period: ' }),
      core.formatPeriod(cov.commonDates[0], cov.commonDates[cov.commonDates.length - 1]) + ' (' + cov.commonDates.length + ' days)']));
    var span = core.diffDays(cov.commonDates[0], cov.commonDates[cov.commonDates.length - 1]) + 1;
    if (span !== cov.commonDates.length) box.appendChild(el('div', { class: 'muted', text: 'Note: within this period some days are missing for someone.' }));
    if (cov.excluded.length) {
      box.appendChild(el('div', { class: 'muted', style: { 'margin-top': '4px' }, text: cov.excluded.length + ' day' + (cov.excluded.length === 1 ? '' : 's') + ' drop out because not everyone has data.' }));
    }
  }

  /* =====================================================================
   * Zoeken & resultaten
   * ===================================================================== */
  function runSearch(scroll) {
    if (!participants.length) return;
    var opts = readOptions();
    var notes = $('resultNotes');
    ui.clear(notes);
    if (opts.timeTo - opts.timeFrom < opts.durationMinutes / core.SLOT_MINUTES) {
      notes.appendChild(alertBox('warn', 'The hours range (' + core.formatSlotRange(opts.timeFrom, opts.timeTo) + ') is shorter than the meeting length.'));
    }
    if (opts.dateFrom && opts.dateTo && opts.dateFrom > opts.dateTo) {
      notes.appendChild(alertBox('warn', 'The start date of the filter is after the end date.'));
    }
    var res;
    try { res = matcher.analyze(participants, opts); }
    catch (e) { notes.appendChild(alertBox('error', 'Something went wrong while calculating: ' + e.message)); return; }
    lastAnalysis = { res: res, opts: opts };

    $('resultsCard').hidden = false;
    renderSummary(res, opts);
    renderResults(matcher.sortResults(res.results, opts.sort), opts);
    renderHeatmap(res, opts);
    if (scroll) ($('heatmapCard').hidden ? $('resultsCard') : $('heatmapCard')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function alertBox(kind, text) {
    return el('div', { class: 'alert alert-' + kind, style: { 'margin-bottom': '12px' } }, [icon(kind === 'info' ? 'info' : 'alert'), el('div', { text: text })]);
  }

  function renderSummary(res, opts) {
    var s = $('resultSummary');
    ui.clear(s);
    var total = res.results.length;
    s.appendChild(el('span', { class: 'badge badge-neutral', text: total + (total === 1 ? ' window' : ' windows') + ' · ' + core.formatMeetingDuration(opts.durationMinutes) }));
    ['physical', 'mixed', 'online', 'partial'].forEach(function (t) {
      if (res.counts[t]) s.appendChild(el('span', { class: 'badge ' + TYPE_INFO[t].badge }, [icon(TYPE_INFO[t].icon), res.counts[t] + ' · ' + shortType(t)]));
    });
    var notes = $('resultNotes');
    if (res.hiddenStarts > 0) {
      notes.appendChild(alertBox('info', res.hiddenStarts + ' other possible start time' + (res.hiddenStarts === 1 ? ' falls' : 'and fall') +
        ' outside your filters (date, hours, days or type).'));
    }
    if (res.excluded.length) {
      var names = {};
      res.excluded.forEach(function (x) { x.missing.forEach(function (m) { names[m] = true; }); });
      notes.appendChild(alertBox('info', res.excluded.length + ' day' + (res.excluded.length === 1 ? '' : 's') +
        ' not analysed because not everyone has data (e.g. ' + Object.keys(names).slice(0, 3).join(', ') + ').'));
    }
  }

  function shortType(t) { return t === 'physical' ? 'everyone on-site' : t === 'mixed' ? 'on-site/online' : t === 'online' ? 'everyone online' : 'not everyone'; }

  function renderResults(results, opts) {
    var box = $('results');
    ui.clear(box);
    var full = results.filter(function (r) { return r.type !== 'partial'; });
    var partial = results.filter(function (r) { return r.type === 'partial'; });
    var n = participants.length;
    if (!results.length) {
      box.appendChild(el('div', { class: 'empty-state' }, [
        el('div', { class: 'big-ico' }, icon('calendar', 'icon-lg')),
        el('h3', { text: 'No shared moments found' }),
        el('p', { text: (opts.minParticipants >= n && n > 1)
          ? 'Try a shorter meeting, wider hours, more days, or choose a "Minimum number of participants" slightly below everyone.'
          : 'Try a shorter meeting, wider hours or more days and types.' })
      ]));
      return;
    }
    if (partial.length) {
      box.appendChild(el('h3', { class: 'section-head' }, [icon('users'), 'Everyone can (' + full.length + ')']));
      if (!full.length) box.appendChild(alertBox('info', 'There is no moment when everyone can attend (with these filters). Below are the moments when at least ' + opts.minParticipants + ' of the ' + n + ' participants can attend.'));
    }
    renderList(box, full, opts, 0);
    if (partial.length) {
      box.appendChild(el('h3', { class: 'section-head partial' }, [icon('users'), 'Almost everyone: at least ' + opts.minParticipants + ' of ' + n + ' (' + partial.length + ')']));
      renderList(box, partial, opts, full.length);
    }
  }

  function renderList(box, results, opts, offset) {
    var grouped = opts.sort === 'chrono';
    var currentDate = null, group = null;
    results.forEach(function (r, i) {
      if (grouped && r.date !== currentDate) {
        currentDate = r.date;
        group = el('div', { class: 'date-group' }, el('h3', {}, [icon('calendar'), core.formatDateLong(r.date)]));
        box.appendChild(group);
      }
      var card = resultCard(r, !grouped, offset + i);
      (grouped ? group : box).appendChild(card);
    });
  }

  function resultCard(r, showDate, i) {
    var info = TYPE_INFO[r.type];
    var single = r.startCount === 1;
    var card = el('article', { class: 'result t-' + r.type, style: { 'animation-delay': Math.min(i, 12) * 25 + 'ms' } });
    card.appendChild(el('div', { class: 'stripe', attrs: { 'aria-hidden': 'true' } }));
    var body = el('div', { class: 'result-body' });

    body.appendChild(el('div', {}, [
      el('div', { class: 'result-time' }, [
        el('span', { class: 'lbl', text: showDate ? core.formatDateLong(r.date) : (single ? 'Meeting moment' : 'Availability window') }),
        core.slotToTime(r.windowStart) + ' – ' + core.slotToTime(r.windowEnd)
      ])
    ]));
    body.appendChild(el('div', {}, el('span', { class: 'badge ' + info.badge }, [icon(info.icon), r.type === 'partial' ? r.availableCount + ' of ' + r.participantCount + ' available' : info.label])));

    var meta = el('div', { class: 'result-meta' }, [
      el('span', {}, ['Meeting length: ', el('b', { text: core.formatMeetingDuration(r.durationSlots * core.SLOT_MINUTES) })]),
      single
        ? el('span', {}, ['Start time: ', el('b', { text: core.slotToTime(r.firstStart) })])
        : el('span', {}, ['Possible start times: ', el('b', { text: core.slotToTime(r.firstStart) + ' to ' + core.slotToTime(r.lastStart) }), ' (' + r.startCount + ')'])
    ]);
    if (r.type === 'partial') meta.appendChild(el('span', {}, [el('b', { text: r.availableCount + '/' + r.participantCount }), ' available: ', el('b', { text: String(r.physicalCount) }), ' on-site', r.onlineCount ? ' · ' : null, r.onlineCount ? el('b', { text: String(r.onlineCount) }) : null, r.onlineCount ? ' online' : null]));
    else if (r.type === 'mixed') meta.appendChild(el('span', {}, [el('b', { text: String(r.physicalCount) }), ' on-site · ', el('b', { text: String(r.onlineCount) }), ' online only']));
    else meta.appendChild(el('span', {}, [el('b', { text: r.participantCount + '/' + r.participantCount }), r.type === 'physical' ? ' on-site' : ' online']));
    body.appendChild(meta);

    if (r.type === 'partial') {
      body.appendChild(el('div', { class: 'result-missing' }, [el('strong', { text: 'Not available: ' }), r.missingNames.join(', ')]));
    }
    if ((r.type === 'mixed' || r.type === 'partial') && r.onlineNames.length) {
      body.appendChild(el('div', { class: 'result-online' }, [el('strong', { text: 'Online needed: ' }), r.onlineNames.join(', ')]));
    }

    var det = el('details', {});
    det.appendChild(el('summary', {}, [icon('chevron'), 'Details']));
    var starts = el('div', { class: 'starts' });
    starts.appendChild(el('span', { text: 'Start between ' + core.slotToTime(r.firstStart) + ' and ' + core.slotToTime(r.lastStart) + ' (every minute)' }));
    det.appendChild(starts);
    det.appendChild(el('div', { class: 'btn-row', style: { 'margin-top': '10px' } }, [
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: function () { highlight(r, card, true); } }, [icon('grid'), 'Show in heatmap'])
    ]));
    body.appendChild(det);

    card.appendChild(body);
    card.addEventListener('mouseenter', function () { highlight(r, card, false); });
    return card;
  }

  function highlight(r, card, scroll) {
    document.querySelectorAll('.result.active').forEach(function (c) { c.classList.remove('active'); });
    document.querySelectorAll('.hl-overlay').forEach(function (o) { o.style.display = 'none'; });
    card.classList.add('active');
    var wrap = document.querySelector('.hm-canvas-wrap[data-date="' + r.date + '"]');
    if (!wrap) return;
    var span = heatTo - heatFrom;
    var ov = wrap.querySelector('.hl-overlay');
    ov.style.left = ((r.windowStart - heatFrom) / span * 100) + '%';
    ov.style.width = ((r.windowEnd - r.windowStart) / span * 100) + '%';
    ov.style.display = 'block';
    if (scroll) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- Heatmap per minuut (getekend op canvas: snel, ook bij lange periodes) ---------- */
  var heatFrom = 0, heatTo = 1440;
  var HM_COL = { phys: '#DE2A2A', onl: '#F5C11A', un: '#EFEAE7', nd: '#E2DBD6', blk: '#D8D2CE', all: '#1E1715' };

  function renderHeatmap(res, opts) {
    var card = $('heatmapCard'), box = $('heatmap');
    ui.clear(box);
    var dates = res.consideredDates;
    if (!dates.length) { card.hidden = true; return; }
    card.hidden = false;
    heatFrom = Math.max(0, Math.min(opts.timeFrom, N - 60));
    heatTo = Math.min(N, Math.max(opts.timeTo, heatFrom + 60));
    var span = heatTo - heatFrom, n = participants.length;
    var ruler = el('div', { class: 'tl-ruler', attrs: { 'aria-hidden': 'true' } });
    for (var h = Math.ceil(heatFrom / 60) * 60; h <= heatTo; h += 60) {
      ruler.appendChild(el('span', { class: 'tick', style: { left: ((h - heatFrom) / span * 100) + '%' }, text: core.slotToTime(h) }));
    }
    box.appendChild(el('div', { class: 'hm-ruler' }, [el('span'), ruler]));
    matcher.heatmap(participants, dates).forEach(function (day) {
      var canvas = el('canvas', { class: 'hm-canvas', attrs: { 'aria-hidden': 'true' } });
      canvas.width = span; canvas.height = 30;
      var wrap = el('div', { class: 'hm-canvas-wrap', dataset: { date: day.date } }, [canvas, el('div', { class: 'hl-overlay' })]);
      drawDay(canvas, day, n);
      wrap._day = day;
      wrap.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') heatTip(e, wrap); });
      wrap.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') heatTip(e, wrap); });
      wrap.addEventListener('pointerleave', function () { tip.hide(); });
      box.appendChild(el('div', { class: 'hm-row' }, [
        el('div', { class: 'hm-label' }, [core.formatDateShort(day.date), el('small', { text: core.isoWeekday(day.date) >= 6 ? 'weekend' : '' })]),
        wrap
      ]));
    });
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Overview of availability of ' + n + ' participants per minute. The results list contains the same information as text.');
  }

  function drawDay(canvas, day, n) {
    var ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
    for (var x = 0; x < w; x++) {
      var m = heatFrom + x;
      if (day.blocked[m]) { ctx.fillStyle = HM_COL.blk; ctx.fillRect(x, 0, 1, h); continue; }
      if (day.nodata[m] === n) { ctx.fillStyle = HM_COL.nd; ctx.fillRect(x, 0, 1, h); continue; }
      var p = day.physical[m], o = day.online[m];
      var hp = Math.round(p / n * h), ho = Math.round((p + o) / n * h);
      ctx.fillStyle = HM_COL.un; ctx.fillRect(x, 0, 1, h);
      if (hp) { ctx.fillStyle = HM_COL.phys; ctx.fillRect(x, h - hp, 1, hp); }
      if (ho > hp) { ctx.fillStyle = HM_COL.onl; ctx.fillRect(x, h - ho, 1, ho - hp); }
      if (p + o === n) { ctx.fillStyle = HM_COL.all; ctx.fillRect(x, 0, 1, 3); }
    }
  }

  function heatTip(e, wrap) {
    var canvas = wrap.querySelector('canvas'), day = wrap._day, n = participants.length;
    var r = canvas.getBoundingClientRect();
    var m = heatFrom + Math.floor((e.clientX - r.left) / Math.max(1, r.width) * (heatTo - heatFrom));
    m = Math.max(heatFrom, Math.min(heatTo - 1, m));
    var sub = day.blocked[m] ? 'Clock change: not available'
      : 'On-site: ' + day.physical[m] + '/' + n + ' · Online: ' + day.online[m] + '/' + n +
        ' · Not available: ' + (day.unavailable[m] + day.nodata[m]) + '/' + n;
    tip.show(e.clientX, r.top, core.formatDateShort(day.date) + ' · ' + core.slotToTime(m) + ' – ' + core.slotToTime(m + 1), sub);
  }

  /* ---------- Kopiëren als tekst ---------- */
  function copyResults() {
    if (!lastAnalysis) return;
    var res = lastAnalysis.res, opts = lastAnalysis.opts;
    var lines = ['Sensibiliseringscampagne orgaandonatie · shared moments',
      'Participants (' + participants.length + '): ' + participants.map(function (p) { return p.fullName; }).join(', '),
      'Meeting length: ' + core.formatMeetingDuration(opts.durationMinutes) + ' · time zone ' + core.TIMEZONE, ''];
    matcher.sortResults(res.results, 'chrono').forEach(function (r) {
      var line = '• ' + core.formatDateLong(r.date) + ', ' + core.slotToTime(r.windowStart) + '–' + core.slotToTime(r.windowEnd) +
        ' · ' + TYPE_INFO[r.type].label +
        (r.startCount > 1 ? ' · start times ' + core.slotToTime(r.firstStart) + ' to ' + core.slotToTime(r.lastStart) : ' · start ' + core.slotToTime(r.firstStart));
      if (r.type === 'partial') line += ' · ' + r.availableCount + '/' + r.participantCount + ' available · not available: ' + r.missingNames.join(', ');
      if ((r.type === 'mixed' || r.type === 'partial') && r.onlineNames.length) line += ' · online needed: ' + r.onlineNames.join(', ');
      lines.push(line);
    });
    if (!res.results.length) lines.push('No shared moments found.');
    ui.copyText(lines.join('\n')).then(function () { ui.toast('Overview copied.', { icon: 'copy' }); },
      function () { ui.toast('Copying did not work in this browser.', { icon: 'alert' }); });
  }

  /* ---------- Uitnodigingslink ---------- */
  function bindInvite() {
    $('invCopy').addEventListener('click', function () {
      var s = $('invStart').value, e = $('invEnd').value, err = $('invErr');
      err.textContent = '';
      if (!core.isValidISODate(s) || !core.isValidISODate(e)) { err.textContent = 'Choose a valid start and end date.'; return; }
      var n = core.diffDays(s, e) + 1;
      if (n < 1) { err.textContent = 'The end date is before the start date.'; return; }
      if (n > core.MAX_PERIOD_DAYS) { err.textContent = 'Maximum ' + core.MAX_PERIOD_DAYS + ' days.'; return; }
      var url = new URL('availability.html', window.location.href);
      url.search = '?start=' + s + '&end=' + e;
      url.hash = '';
      ui.copyText(url.toString()).then(function () { ui.toast('Link copied: share it with your group.', { icon: 'link' }); },
        function () { window.prompt('Copy this link:', url.toString()); });
    });
  }

  function formatStamp(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 'onbekend';
    return core.nowBrusselsISO(t).slice(0, 16).replace('T', ' ');
  }
})();
