/*!
 * Sensibiliseringscampagne orgaandonatie – core.js
 * ------------------------------------------------------------------
 * Gedeelde, framework-loze logica voor de deelnemers- én coördinatorpagina:
 *   - constanten en het JSON-schema (versie 1)
 *   - datum- en tijdhulpfuncties (zonder afhankelijkheid van de tijdzone van het toestel)
 *   - tijdzone Europe/Brussels incl. zomer-/wintertijd (DST)
 *   - opbouwen (export) en strikt valideren (import) van beschikbaarheidsbestanden
 *   - bestandsnaam-sanitizing
 *
 * Dit bestand bevat GEEN DOM-code, zodat het ook in Node.js getest kan worden
 * (zie tests/run-tests.js).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.Orgaandonatie = root.Orgaandonatie || {}; root.Orgaandonatie.core = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================================================================
   * 1. Constanten
   * ================================================================ */
  var SCHEMA_ID = 'orgaandonatie-planning';
  var SCHEMA_VERSION = 1;
  var APP_NAME = 'Sensibiliseringscampagne orgaandonatie';
  var APP_VERSION = '1.0.0';
  var TIMEZONE = 'Europe/Brussels';
  var SLOT_MINUTES = 1;
  var SLOTS_PER_DAY = 1440;            // 24 * 60 minuten
  var MAX_PERIOD_DAYS = 62;          // maximaal ± 2 maanden per bestand (deelnemerspagina)
  var MAX_IMPORT_PERIOD_DAYS = 366;  // harde bovengrens bij import
  var MAX_FILE_BYTES = 2 * 1024 * 1024;
  var MAX_NAME_LENGTH = 60;

  /** Statuscodes zoals intern gebruikt (1 byte per minuut). */
  var STATUS = { UNAVAILABLE: 0, PHYSICAL: 1, ONLINE: 2 };
  /** Statusnamen zoals in het JSON-bestand. Index = statuscode. */
  var STATUS_NAMES = ['unavailable', 'physical', 'online'];
  var STATUS_LABELS = ['Unavailable', 'Available on-site', 'Available online only'];

  /** Vlaggen voor tijdsblokken die door een klokwissel niet eenduidig zijn. */
  var BLOCK = { NONE: 0, NONEXISTENT: 1, AMBIGUOUS: 2 };

  /* ================================================================
   * 2. Datums (altijd als 'YYYY-MM-DD' strings, gerekend in UTC)
   *    → geen fouten door de tijdzone of DST van het toestel.
   * ================================================================ */
  var ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function parseISODate(iso) {
    if (typeof iso !== 'string') return null;
    var m = ISO_DATE_RE.exec(iso);
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100) return null;
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: mo, d: d, t: t };
  }

  function isValidISODate(iso) { return parseISODate(iso) !== null; }

  function isoFromUTC(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function addDays(iso, n) {
    var p = parseISODate(iso);
    return isoFromUTC(Date.UTC(p.y, p.m - 1, p.d + n));
  }

  /** Aantal dagen van a naar b (b - a). */
  function diffDays(a, b) {
    return Math.round((parseISODate(b).t - parseISODate(a).t) / 86400000);
  }

  /** Alle datums van start t/m end (inclusief). */
  function dateRange(start, end) {
    var out = [];
    var n = diffDays(start, end);
    for (var i = 0; i <= n; i++) out.push(addDays(start, i));
    return out;
  }

  /** ISO-weekdag: 1 = maandag … 7 = zondag. */
  function isoWeekday(iso) {
    var wd = new Date(parseISODate(iso).t).getUTCDay();
    return wd === 0 ? 7 : wd;
  }

  var WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  /** "Maandag 5 oktober 2026" */
  function formatDateLong(iso, withYear) {
    var p = parseISODate(iso);
    return capitalize(WEEKDAY_NAMES[isoWeekday(iso) - 1]) + ' ' + p.d + ' ' + MONTH_NAMES[p.m - 1] +
      (withYear === false ? '' : ' ' + p.y);
  }

  /** "ma 5 okt" */
  function formatDateShort(iso) {
    var p = parseISODate(iso);
    return WEEKDAY_SHORT[isoWeekday(iso) - 1] + ' ' + p.d + ' ' + MONTH_NAMES[p.m - 1].slice(0, 3);
  }

  /** "5 oktober – 18 oktober 2026" */
  function formatPeriod(start, end) {
    var a = parseISODate(start), b = parseISODate(end);
    var left = a.d + ' ' + MONTH_NAMES[a.m - 1] + (a.y !== b.y ? ' ' + a.y : '');
    return left + ' – ' + b.d + ' ' + MONTH_NAMES[b.m - 1] + ' ' + b.y;
  }

  /** "05/10/2026" (Belgische notatie) */
  function formatDateNumeric(iso) {
    var p = parseISODate(iso);
    return pad2(p.d) + '/' + pad2(p.m) + '/' + p.y;
  }

  /* ================================================================
   * 3. Tijdsblokken
   * ================================================================ */
  var TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  /** Slotindex (0…96) → "HH:MM". 96 → "24:00". */
  function slotToTime(i) {
    var mins = i * SLOT_MINUTES;
    return pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
  }

  /**
   * "HH:MM" → slotindex. Elke minuut van de dag is geldig.
   * "24:00" is enkel toegestaan als eindtijd (allowEnd = true).
   * Geeft -1 bij een ongeldige waarde.
   */
  function timeToSlot(str, allowEnd) {
    if (allowEnd && str === '24:00') return SLOTS_PER_DAY;
    var m = TIME_RE.exec(str);
    if (!m) return -1;
    var mins = (+m[1]) * 60 + (+m[2]);
    if (mins % SLOT_MINUTES !== 0) return -1;
    return mins / SLOT_MINUTES;
  }

  function formatSlotRange(a, b) { return slotToTime(a) + ' – ' + slotToTime(b); }

  /** Minuten → "32 uur", "7,5 uur", "45 min", "0 uur" */
  function formatDuration(minutes) {
    if (minutes === 0) return '0 h';
    if (minutes < 60) return minutes + ' min';
    var h = minutes / 60;
    var txt = (Math.round(h * 100) / 100).toString();
    return txt + ' h';
  }

  /** Minuten → "1 u 30 min" / "60 min" (voor vergaderduur) */
  function formatMeetingDuration(minutes) {
    if (minutes <= 60) return minutes + ' min';
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return h + 'h' + (m ? ' ' + m + ' min' : '');
  }

  /* ================================================================
   * 4. Tijdzone Europe/Brussels en zomer-/wintertijd
   * ================================================================
   * Alle tijden in het bestand zijn LOKALE KLOKTIJDEN in Europe/Brussels.
   * Op de dag van een klokwissel is één uur problematisch:
   *   - laatste zondag van maart: 02:00–03:00 bestaat niet (klok springt vooruit)
   *   - laatste zondag van oktober: 02:00–03:00 komt twee keer voor
   * Die blokken worden overal uitgeschakeld ("geblokkeerd"), zodat er nooit
   * een dubbelzinnig tijdstip in een bestand of resultaat kan staan.
   * De berekening gebeurt met Intl en is dus correct voor elk jaar.
   */
  var _dtf = null;
  function getFormatter() {
    if (_dtf === null) {
      try {
        _dtf = new Intl.DateTimeFormat('en-GB', {
          timeZone: TIMEZONE, hourCycle: 'h23',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
      } catch (e) { _dtf = false; }
    }
    return _dtf;
  }

  /** Lokale wandklok-onderdelen in Brussel voor een UTC-tijdstip (ms). */
  function brusselsParts(utcMs) {
    var f = getFormatter();
    if (!f) return null;
    var parts = f.formatToParts(new Date(utcMs));
    var o = {};
    for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
    return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, s: +o.second };
  }

  /** UTC-offset van Brussel in minuten op een UTC-tijdstip (60 = CET, 120 = CEST). */
  function brusselsOffsetMinutes(utcMs) {
    var p = brusselsParts(utcMs);
    if (!p) return 60;
    var asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    return Math.round((asUTC - Math.floor(utcMs / 1000) * 1000) / 60000);
  }

  var _blockCache = {};
  /**
   * Geeft per dag een Uint8Array(96) met BLOCK-vlaggen.
   * 0 = normaal, 1 = bestaat niet (lente), 2 = dubbelzinnig (herfst).
   */
  function blockedSlots(iso) {
    if (_blockCache[iso]) return _blockCache[iso];
    var res = new Uint8Array(SLOTS_PER_DAY);
    var p = parseISODate(iso);
    var offA = brusselsOffsetMinutes(Date.UTC(p.y, p.m - 1, p.d) - 14 * 3600000);
    var offB = brusselsOffsetMinutes(Date.UTC(p.y, p.m - 1, p.d + 1) + 14 * 3600000);
    if (offA !== offB) {
      var offsets = [offA, offB];
      for (var i = 0; i < SLOTS_PER_DAY; i++) {
        var wall = Date.UTC(p.y, p.m - 1, p.d, 0, i * SLOT_MINUTES);
        var count = 0;
        for (var k = 0; k < offsets.length; k++) {
          var utc = wall - offsets[k] * 60000;
          if (brusselsOffsetMinutes(utc) === offsets[k]) count++;
        }
        if (count === 0) res[i] = BLOCK.NONEXISTENT;
        else if (count === 2) res[i] = BLOCK.AMBIGUOUS;
      }
    }
    _blockCache[iso] = res;
    return res;
  }

  function hasBlockedSlots(iso) {
    var b = blockedSlots(iso);
    for (var i = 0; i < b.length; i++) if (b[i]) return true;
    return false;
  }

  /** Huidige datum in Brussel als 'YYYY-MM-DD'. */
  function todayBrussels() {
    var p = brusselsParts(Date.now());
    if (!p) { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
  }

  /** Huidig tijdstip als ISO 8601 met Brusselse offset, bv. "2026-10-02T16:10:00+02:00". */
  function nowBrusselsISO(utcMs) {
    var t = utcMs === undefined ? Date.now() : utcMs;
    var p = brusselsParts(t);
    if (!p) return new Date(t).toISOString();
    var off = brusselsOffsetMinutes(t);
    var sign = off >= 0 ? '+' : '-';
    var a = Math.abs(off);
    return p.y + '-' + pad2(p.m) + '-' + pad2(p.d) + 'T' + pad2(p.h) + ':' + pad2(p.mi) + ':' + pad2(p.s) +
      sign + pad2(Math.floor(a / 60)) + ':' + pad2(a % 60);
  }

  /* ================================================================
   * 5. Namen en bestandsnamen
   * ================================================================ */
  /** Opschonen van een naam: controle-tekens weg, spaties normaliseren, lengte beperken. */
  function cleanName(s) {
    if (typeof s !== 'string') return '';
    var t = s.normalize ? s.normalize('NFC') : s;
    t = t.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF<>]/g, '');
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > MAX_NAME_LENGTH) t = t.slice(0, MAX_NAME_LENGTH).trim();
    return t;
  }

  function stripDiacritics(s) {
    return (s.normalize ? s.normalize('NFKD') : s).replace(/[\u0300-\u036f]/g, '');
  }

  /** Sleutel om dubbele personen te herkennen ("Ali  ALHAYEK" == "ali alhayek"). */
  function nameKey(fullName) {
    return stripDiacritics(cleanName(fullName)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Veilig deel van een bestandsnaam: enkel A–Z, a–z, 0–9 en '-'. */
  function sanitizeFilenamePart(s, fallback) {
    var t = stripDiacritics(cleanName(s || ''))
      .replace(/[^A-Za-z0-9-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '');
    if (t.length > 40) t = t.slice(0, 40).replace(/[_-]+$/, '');
    return t || fallback || 'Unknown';
  }

  /** Sensibiliseringscampagne_orgaandonatie_Planning_Ali_Alhayek_2026-10-05_2026-10-18.json */
  function buildFilename(firstName, lastName, start, end) {
    return 'Sensibiliseringscampagne_orgaandonatie_Planning_' + sanitizeFilenamePart(firstName, 'Voornaam') + '_' +
      sanitizeFilenamePart(lastName, 'Familienaam') + '_' + start + '_' + end + '.json';
  }

  /* ================================================================
   * 6. Beschikbaarheid: slots ⇄ intervallen
   * ================================================================ */
  function emptyDay() { return new Uint8Array(SLOTS_PER_DAY); }

  /** Run-length: Uint8Array(96) → [{start,end,status}] (alleen physical/online). */
  function slotsToIntervals(arr) {
    var out = [];
    var i = 0;
    while (i < SLOTS_PER_DAY) {
      var s = arr[i];
      var j = i + 1;
      while (j < SLOTS_PER_DAY && arr[j] === s) j++;
      if (s === STATUS.PHYSICAL || s === STATUS.ONLINE) {
        out.push({ start: slotToTime(i), end: slotToTime(j), status: STATUS_NAMES[s] });
      }
      i = j;
    }
    return out;
  }

  /** Totale minuten per status over een map {datum: Uint8Array}. */
  function computeTotals(slotsByDate, dates) {
    var phys = 0, online = 0, daysWithData = 0;
    var keys = dates || Object.keys(slotsByDate);
    for (var k = 0; k < keys.length; k++) {
      var arr = slotsByDate[keys[k]];
      if (!arr) continue;
      var any = false;
      for (var i = 0; i < SLOTS_PER_DAY; i++) {
        if (arr[i] === STATUS.PHYSICAL) { phys++; any = true; }
        else if (arr[i] === STATUS.ONLINE) { online++; any = true; }
      }
      if (any) daysWithData++;
    }
    return { physicalMinutes: phys * SLOT_MINUTES, onlineMinutes: online * SLOT_MINUTES, daysWithAvailability: daysWithData };
  }

  /**
   * Bouwt het JSON-document (schema v1) dat de deelnemer downloadt/indient.
   * @param {object} p {firstName, lastName, start, end, slots: {iso: Uint8Array}}
   */
  function buildDocument(p, nowUtcMs) {
    var firstName = cleanName(p.firstName), lastName = cleanName(p.lastName);
    var dates = dateRange(p.start, p.end);
    var days = {};
    for (var i = 0; i < dates.length; i++) {
      var arr = p.slots[dates[i]] || emptyDay();
      // Geblokkeerde DST-blokken worden nooit geëxporteerd.
      var b = blockedSlots(dates[i]);
      var clean = new Uint8Array(arr);
      for (var s = 0; s < SLOTS_PER_DAY; s++) if (b[s]) clean[s] = STATUS.UNAVAILABLE;
      days[dates[i]] = slotsToIntervals(clean);
    }
    var totals = computeTotals(p.slots, dates);
    return {
      schema: SCHEMA_ID,
      version: SCHEMA_VERSION,
      participant: {
        firstName: firstName,
        lastName: lastName,
        fullName: (firstName + ' ' + lastName).trim()
      },
      period: { start: p.start, end: p.end },
      timezone: TIMEZONE,
      slotMinutes: SLOT_MINUTES,
      submittedAt: nowBrusselsISO(nowUtcMs),
      generator: { app: APP_NAME, version: APP_VERSION },
      statusLegend: {
        unavailable: STATUS_LABELS[0] + ' (standaard: alles wat niet in "days" staat)',
        physical: STATUS_LABELS[1],
        online: STATUS_LABELS[2]
      },
      summary: {
        days: dates.length,
        daysWithAvailability: totals.daysWithAvailability,
        physicalMinutes: totals.physicalMinutes,
        onlineMinutes: totals.onlineMinutes
      },
      days: days
    };
  }

  /* ================================================================
   * 7. Validatie van een geïmporteerd bestand (onbetrouwbare input!)
   * ================================================================
   * Geeft altijd een object terug, gooit nooit een fout:
   *   { ok: boolean, errors: [string], warnings: [string], data: {...} | null }
   */
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function validateDocument(doc) {
    var errors = [], warnings = [];
    function fail(msg) { errors.push(msg); return { ok: false, errors: errors, warnings: warnings, data: null }; }

    if (!isPlainObject(doc)) return fail('The file does not contain a valid JSON object.');
    if (doc.schema !== SCHEMA_ID) return fail('This is not an availability file for this campaign (the "schema" field is missing or wrong).');
    if (typeof doc.version !== 'number' || Math.floor(doc.version) !== doc.version) return fail('Invalid schema version.');
    if (doc.version > SCHEMA_VERSION) return fail('Schema version ' + doc.version + ' is newer than this website supports (v' + SCHEMA_VERSION + '). Refresh the page.');
    if (doc.version < 1) return fail('Invalid schema version.');

    // Deelnemer
    var part = doc.participant;
    if (!isPlainObject(part)) return fail('Participant details are missing.');
    var firstName = cleanName(part.firstName), lastName = cleanName(part.lastName);
    if (!firstName && !lastName) return fail('The participant name is missing.');
    if (!firstName) warnings.push('First name is missing.');
    if (!lastName) warnings.push('Last name is missing.');
    var fullName = (firstName + ' ' + lastName).trim();
    if (typeof part.fullName === 'string' && nameKey(part.fullName) !== nameKey(fullName)) {
      warnings.push('Full name does not match first and last name; "' + fullName + '" is used.');
    }

    // Tijdzone & raster
    if (doc.timezone !== TIMEZONE) return fail('Unexpected time zone "' + String(doc.timezone).slice(0, 40) + '" (expected: ' + TIMEZONE + ').');
    if (doc.slotMinutes !== SLOT_MINUTES) return fail('Unexpected block size (expected: ' + SLOT_MINUTES + ' minutes).');

    // Periode
    var period = doc.period;
    if (!isPlainObject(period)) return fail('Period is missing.');
    if (!isValidISODate(period.start) || !isValidISODate(period.end)) return fail('Invalid start or end date in the period.');
    if (diffDays(period.start, period.end) < 0) return fail('The end date is before the start date.');
    if (diffDays(period.start, period.end) + 1 > MAX_IMPORT_PERIOD_DAYS) return fail('The period is too long (maximum ' + MAX_IMPORT_PERIOD_DAYS + ' days).');

    // Indiendatum (informatief)
    var submittedAt = typeof doc.submittedAt === 'string' && !isNaN(Date.parse(doc.submittedAt)) ? doc.submittedAt : null;
    if (!submittedAt) warnings.push('Submission date is missing or invalid.');

    // Dagen
    if (!isPlainObject(doc.days)) return fail('Availability per day ("days") is missing.');
    var dates = dateRange(period.start, period.end);
    var inPeriod = {};
    for (var i = 0; i < dates.length; i++) inPeriod[dates[i]] = true;

    var slots = {};
    var covered = [];
    var missing = [];
    var dayKeys = Object.keys(doc.days);
    for (var k = 0; k < dayKeys.length; k++) {
      var key = dayKeys[k];
      if (!isValidISODate(key)) { errors.push('Invalid date "' + String(key).slice(0, 20) + '" in "days".'); continue; }
      if (!inPeriod[key]) { warnings.push('Day ' + formatDateNumeric(key) + ' is outside the given period and is ignored.'); continue; }
    }
    if (errors.length) return { ok: false, errors: errors, warnings: warnings, data: null };

    var blockedIgnored = 0;
    for (var d = 0; d < dates.length; d++) {
      var iso = dates[d];
      if (!Object.prototype.hasOwnProperty.call(doc.days, iso)) { missing.push(iso); continue; }
      var list = doc.days[iso];
      if (!Array.isArray(list)) { errors.push(formatDateNumeric(iso) + ': expected a list of time ranges.'); continue; }
      if (list.length > SLOTS_PER_DAY) { errors.push(formatDateNumeric(iso) + ': too many time ranges.'); continue; }
      var arr = emptyDay();
      var blocked = blockedSlots(iso);
      for (var j = 0; j < list.length; j++) {
        var it = list[j];
        var where = formatDateNumeric(iso) + ', time range ' + (j + 1);
        if (!isPlainObject(it)) { errors.push(where + ': invalid format.'); continue; }
        var a = timeToSlot(it.start, false), b = timeToSlot(it.end, true);
        if (a < 0 || b < 0) { errors.push(where + ': times must be written as HH:MM (00:00 to 24:00).'); continue; }
        if (b <= a) { errors.push(where + ': end time must be after the start time.'); continue; }
        var code = STATUS_NAMES.indexOf(it.status);
        if (code < 0) { errors.push(where + ': unknown status "' + String(it.status).slice(0, 20) + '" (allowed: ' + STATUS_NAMES.join(', ') + ').'); continue; }
        for (var s = a; s < b; s++) {
          if (arr[s] !== STATUS.UNAVAILABLE && code !== STATUS.UNAVAILABLE) {
            errors.push(where + ': overlaps with another time range (' + slotToTime(s) + ').');
            break;
          }
          if (code === STATUS.UNAVAILABLE) continue;
          if (blocked[s]) { blockedIgnored++; continue; }
          arr[s] = code;
        }
      }
      slots[iso] = arr;
      covered.push(iso);
    }
    if (errors.length) {
      if (errors.length > 8) errors = errors.slice(0, 8).concat(['… and ' + (errors.length - 8) + ' other errors.']);
      return { ok: false, errors: errors, warnings: warnings, data: null };
    }
    if (blockedIgnored) warnings.push('Time ranges during the clock change (02:00–03:00) were ignored.');
    if (missing.length) {
      warnings.push(missing.length === 1
        ? 'Day ' + formatDateNumeric(missing[0]) + ' is missing from the file and is treated as "no data".'
        : missing.length + ' days are missing from the file (e.g. ' + formatDateNumeric(missing[0]) + ') and are treated as "no data".');
    }
    if (!covered.length) return fail('The file contains no day with data.');

    var totals = computeTotals(slots, covered);
    if (totals.physicalMinutes + totals.onlineMinutes === 0) warnings.push('This person has not marked any availability.');

    return {
      ok: true, errors: errors, warnings: warnings,
      data: {
        firstName: firstName, lastName: lastName, fullName: fullName, key: nameKey(fullName),
        start: period.start, end: period.end, submittedAt: submittedAt,
        dates: dates, covered: covered, missing: missing, slots: slots, totals: totals
      }
    };
  }

  /** Parse + valideer ruwe tekst (bestandsinhoud). Gooit nooit een fout. */
  function parseAndValidate(text) {
    if (typeof text !== 'string') return { ok: false, errors: ['The file could not be read.'], warnings: [], data: null };
    if (text.length > MAX_FILE_BYTES) return { ok: false, errors: ['The file is too large (max. 2 MB).'], warnings: [], data: null };
    var doc;
    try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (e) { return { ok: false, errors: ['Not a valid JSON file (the file is damaged or of another type).'], warnings: [], data: null }; }
    try { return validateDocument(doc); }
    catch (e2) { return { ok: false, errors: ['Unexpected error while checking the file.'], warnings: [], data: null }; }
  }

  return {
    SCHEMA_ID: SCHEMA_ID, SCHEMA_VERSION: SCHEMA_VERSION, APP_NAME: APP_NAME, APP_VERSION: APP_VERSION,
    TIMEZONE: TIMEZONE, SLOT_MINUTES: SLOT_MINUTES, SLOTS_PER_DAY: SLOTS_PER_DAY,
    MAX_PERIOD_DAYS: MAX_PERIOD_DAYS, MAX_FILE_BYTES: MAX_FILE_BYTES, MAX_NAME_LENGTH: MAX_NAME_LENGTH,
    STATUS: STATUS, STATUS_NAMES: STATUS_NAMES, STATUS_LABELS: STATUS_LABELS, BLOCK: BLOCK,
    WEEKDAY_NAMES: WEEKDAY_NAMES, WEEKDAY_SHORT: WEEKDAY_SHORT, MONTH_NAMES: MONTH_NAMES,
    pad2: pad2, parseISODate: parseISODate, isValidISODate: isValidISODate, addDays: addDays,
    diffDays: diffDays, dateRange: dateRange, isoWeekday: isoWeekday,
    formatDateLong: formatDateLong, formatDateShort: formatDateShort, formatPeriod: formatPeriod,
    formatDateNumeric: formatDateNumeric, slotToTime: slotToTime, timeToSlot: timeToSlot,
    formatSlotRange: formatSlotRange, formatDuration: formatDuration, formatMeetingDuration: formatMeetingDuration,
    brusselsOffsetMinutes: brusselsOffsetMinutes, blockedSlots: blockedSlots, hasBlockedSlots: hasBlockedSlots,
    todayBrussels: todayBrussels, nowBrusselsISO: nowBrusselsISO,
    cleanName: cleanName, nameKey: nameKey, sanitizeFilenamePart: sanitizeFilenamePart, buildFilename: buildFilename,
    emptyDay: emptyDay, slotsToIntervals: slotsToIntervals, computeTotals: computeTotals,
    buildDocument: buildDocument, validateDocument: validateDocument, parseAndValidate: parseAndValidate
  };
});
