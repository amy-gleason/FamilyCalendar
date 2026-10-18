/**
 * Where is My Fam: sends Amy's TRAVEL from her Google Calendar to Firebase.
 * Runs inside Amy's own Google account (Apps Script). No tagging needed.
 *
 * What it does
 *  - Finds flights (Flighty, Gmail, or typed by hand), hotel/Airbnb stays and multi-day all-day city blocks.
 *  - Builds each trip from parsed pieces only: city, dates, and a flight line (carrier, number, airports, times).
 *    It never copies titles, descriptions, street addresses, guests, links or confirmation codes.
 *  - Merges duplicates (same city with overlapping dates, same flight number and day), across ALL calendars.
 *  - Skips private events, declined events and non-travel appointments (doctor, lab, etc.).
 *  - Optional overrides still work: a title starting "Trip:" or "Flight:" is trusted as typed,
 *    and a title starting "Hide:" is never read.
 *
 * SAFETY: DRY_RUN is true. While it is true, nothing is written. Run `sync`, read the log, then
 * set DRY_RUN = false (see README step 4).
 */
var WHO = 'Amy';
var DB_URL = 'https://travel-calendar-1c760-default-rtdb.firebaseio.com';
var DRY_RUN = true;          // true = only log what WOULD be published. Flip to false after reviewing the log.
var HIDE_TENTATIVE = false;  // Amy chose "show all": tentative trips are shown and marked "tentative".
var DAYS_BACK = 7, DAYS_AHEAD = 400;
var MAX_STAY_DAYS = 21;      // longer blocks (e.g. a 7-week Airbnb) are treated as a base, not a trip, and skipped
var TRIP_GAP_DAYS = 14;      // out-and-back flights within this many days make a trip when there is no stay event

// ---------- lookup tables (add rows as needed) ----------
// airport code: [city shown on the page, time zone]
var AIRPORTS = {
  DCA: ['Washington, DC', 'America/New_York'], IAD: ['Washington, DC', 'America/New_York'], BWI: ['Baltimore, MD', 'America/New_York'],
  BNA: ['Nashville, TN', 'America/Chicago'], TYS: ['Knoxville, TN', 'America/New_York'], MEM: ['Memphis, TN', 'America/Chicago'],
  AUS: ['Austin, TX', 'America/Chicago'], CLL: ['College Station, TX', 'America/Chicago'], IAH: ['Houston, TX', 'America/Chicago'],
  HOU: ['Houston, TX', 'America/Chicago'], DFW: ['Dallas, TX', 'America/Chicago'], DAL: ['Dallas, TX', 'America/Chicago'],
  SAT: ['San Antonio, TX', 'America/Chicago'], ELP: ['El Paso, TX', 'America/Denver'],
  MCO: ['Orlando, FL', 'America/New_York'], MIA: ['Miami, FL', 'America/New_York'], FLL: ['Fort Lauderdale, FL', 'America/New_York'],
  TPA: ['Tampa, FL', 'America/New_York'], JAX: ['Jacksonville, FL', 'America/New_York'], PNS: ['Pensacola, FL', 'America/Chicago'],
  LAS: ['Las Vegas, NV', 'America/Los_Angeles'], SAF: ['Santa Fe, NM', 'America/Denver'], ABQ: ['Albuquerque, NM', 'America/Denver'],
  ATL: ['Atlanta, GA', 'America/New_York'], SAV: ['Savannah, GA', 'America/New_York'],
  MOB: ['Mobile, AL', 'America/Chicago'], BHM: ['Birmingham, AL', 'America/Chicago'], HSV: ['Huntsville, AL', 'America/Chicago'],
  MSY: ['New Orleans, LA', 'America/Chicago'], JFK: ['New York, NY', 'America/New_York'], LGA: ['New York, NY', 'America/New_York'],
  EWR: ['New York, NY', 'America/New_York'], BOS: ['Boston, MA', 'America/New_York'], PHL: ['Philadelphia, PA', 'America/New_York'],
  PIT: ['Pittsburgh, PA', 'America/New_York'], CLT: ['Charlotte, NC', 'America/New_York'], RDU: ['Raleigh, NC', 'America/New_York'],
  CHS: ['Charleston, SC', 'America/New_York'], GSP: ['Greenville, SC', 'America/New_York'], RIC: ['Richmond, VA', 'America/New_York'],
  ORF: ['Norfolk, VA', 'America/New_York'], ORD: ['Chicago, IL', 'America/Chicago'], MDW: ['Chicago, IL', 'America/Chicago'],
  DEN: ['Denver, CO', 'America/Denver'], SLC: ['Salt Lake City, UT', 'America/Denver'], PHX: ['Phoenix, AZ', 'America/Phoenix'],
  LAX: ['Los Angeles, CA', 'America/Los_Angeles'], SFO: ['San Francisco, CA', 'America/Los_Angeles'], SAN: ['San Diego, CA', 'America/Los_Angeles'],
  SEA: ['Seattle, WA', 'America/Los_Angeles'], PDX: ['Portland, OR', 'America/Los_Angeles'], MSP: ['Minneapolis, MN', 'America/Chicago'],
  DTW: ['Detroit, MI', 'America/New_York'], CLE: ['Cleveland, OH', 'America/New_York'], CMH: ['Columbus, OH', 'America/New_York'],
  CVG: ['Cincinnati, OH', 'America/New_York'], IND: ['Indianapolis, IN', 'America/New_York'], STL: ['St. Louis, MO', 'America/Chicago'],
  MCI: ['Kansas City, MO', 'America/Chicago'], SDF: ['Louisville, KY', 'America/New_York'], OKC: ['Oklahoma City, OK', 'America/Chicago'],
  HNL: ['Honolulu, HI', 'Pacific/Honolulu']
};
// extra spellings that should resolve to a city shown above (the city name itself is added automatically)
var CITY_ALIASES = {
  'Washington, DC': ['washington dc', 'washington d.c.', 'd.c.', 'dc'],
  'Las Vegas, NV': ['vegas'],
  'College Station, TX': ['bryan'],
  'Dallas, TX': ['dallas/fort worth', 'dallas/ft worth', 'dallas fort worth', 'fort worth', 'ft worth', 'dfw'],
  'New York, NY': ['nyc', 'new york city'],
  'St. Louis, MO': ['saint louis', 'st louis']
};
var CARRIERS = { WN: 'Southwest', AA: 'American', DL: 'Delta', UA: 'United', B6: 'JetBlue', AS: 'Alaska', NK: 'Spirit', F9: 'Frontier', G4: 'Allegiant', HA: 'Hawaiian', AC: 'Air Canada' };
var CARRIER_WORDS = { southwest: 'WN', american: 'AA', delta: 'DL', united: 'UA', jetblue: 'B6', alaska: 'AS', spirit: 'NK', frontier: 'F9', allegiant: 'G4', hawaiian: 'HA' };
var DENY_RE = /\b(doctor|dr\.?|dentist|dental|clinic|hospital|therapy|therapist|surgery|lab|mri|ct scan|er|pharmacy|appointment|funeral|court|lawyer|attorney|interview|physical|checkup|counseling)\b/i;
var TENTATIVE_RE = /tentative|not yet booked|\bmaybe\b|\bpending\b|\bmay return\b|\?/i;
var LODGING_RE = /\b(stay|hotel|inn|airbnb|resort|lodge|suites?|hyatt|marriott|hilton|motel|residence)\b/i;

// ---------- entry point ----------
function sync() {
  var result = buildTrips(readCalendarEvents(), new Date());
  result.log.forEach(function (l) { Logger.log(l); });
  var n = Object.keys(result.out).length;
  if (DRY_RUN) {
    Logger.log('DRY RUN: nothing was written. ' + n + ' trips would be published. Review the lines above, then set DRY_RUN = false.');
    return;
  }
  var res = UrlFetchApp.fetch(DB_URL + '/trips.json?access_token=' + ScriptApp.getOAuthToken(), {
    method: 'put', contentType: 'application/json', payload: JSON.stringify(result.out), muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + n + ' trips');
}

function readCalendarEvents() {
  var now = new Date();
  var from = new Date(now.getTime() - DAYS_BACK * 864e5);
  var to = new Date(now.getTime() + DAYS_AHEAD * 864e5);
  var list = [];
  CalendarApp.getAllCalendars().forEach(function (cal) {
    cal.getEvents(from, to).forEach(function (ev) {
      var allDay = ev.isAllDayEvent();
      var declined = false;
      try { declined = ev.getMyStatus() === CalendarApp.GuestStatus.NO; } catch (e) {}
      list.push({
        title: (ev.getTitle() || '').trim(),
        location: ev.getLocation() || '',
        allDay: allDay,
        start: ev.getStartTime(), end: ev.getEndTime(),
        startYmd: allDay ? ymd(ev.getAllDayStartDate()) : ymd(ev.getStartTime()),
        // Google's all-day end is the day AFTER the last day; the site treats end as inclusive (the day you leave),
        // so Google's end date is kept as is: an all-day event on Oct 26-28 shows 26, 27 and 28.
        endYmd: allDay ? ymd(ev.getAllDayEndDate()) : ymd(ev.getEndTime()),
        priv: ev.getVisibility() === CalendarApp.Visibility.PRIVATE,
        declined: declined
      });
    });
  });
  return list;
}

// ---------- the logic (pure functions of plain event objects) ----------
function buildTrips(events, now) {
  var log = [], stays = [], flights = [];
  events.forEach(function (e) {
    var t = e.title;
    if (/^hide:/i.test(t)) { log.push('SKIPPED (Hide:): ' + t); return; }
    if (e.priv) { log.push('SKIPPED (private): ' + t); return; }
    if (e.declined) { log.push('SKIPPED (declined): ' + t); return; }
    var tent = TENTATIVE_RE.test(t);
    if (/^trip:/i.test(t)) { stays.push(explicitStay(e, t)); return; }
    if (/^flight:/i.test(t)) {
      var txt = t.replace(/^flight:\s*/i, '');
      flights.push({ date: e.startYmd, text: txt, key: 'T|' + txt.toLowerCase() + '|' + e.startYmd, from: null, to: null, toCity: null, fromCity: null, tent: false, src: t });
      return;
    }
    var f = parseFlight(e);
    if (f) {
      if (!f.line) { log.push('SKIPPED (flight with no number or airports): ' + t); return; }
      f.tent = tent; f.src = t; flights.push(f);
      return;
    }
    if (e.allDay) {
      var nights = dayDiff(e.startYmd, e.endYmd);
      if (nights < 1) return; // single-day all-day events are not stays
      if (nights > MAX_STAY_DAYS) { log.push('SKIPPED (longer than ' + MAX_STAY_DAYS + ' days, treated as a base): ' + t + ' ' + e.startYmd + ' to ' + e.endYmd); return; }
      var city = resolveCity(t) || resolveCity(e.location);
      if (!city && LODGING_RE.test(t)) city = cityFromAddress(e.location);
      if (!city) { if (LODGING_RE.test(t)) log.push('SKIPPED (no city found): ' + t); return; }
      stays.push({ city: city, start: e.startYmd, end: e.endYmd, note: '', tent: tent, deny: DENY_RE.test(t), src: t, explicit: false });
    }
  });

  // flights: dedupe by carrier+number+day (or typed text), keep the richest copy
  var fl = {};
  flights.forEach(function (f) {
    var k = f.key;
    if (!fl[k]) { fl[k] = f; return; }
    log.push('MERGED duplicate flight: ' + f.src + '  =  ' + fl[k].src);
    if (richness(f) > richness(fl[k])) { f.tent = f.tent && fl[k].tent; fl[k] = f; } else { fl[k].tent = fl[k].tent && f.tent; }
  });
  flights = Object.keys(fl).map(function (k) { return fl[k]; }).sort(function (a, b) { return a.startMs - b.startMs || (a.date < b.date ? -1 : 1); });

  // deny-list stays are kept only when a flight lands/leaves within a day (that is travel, Amy: show all travel)
  stays = stays.filter(function (s) {
    if (!s.deny) return true;
    var near = flights.some(function (f) { return nearRange(f.date, s); });
    if (!near) log.push('SKIPPED (looks like an appointment, no flight nearby): ' + s.src);
    return near;
  });

  // infer a trip from out-and-back flights when no stay covers the arrival
  flights.forEach(function (f, i) {
    if (!f.toCity) return;
    var covered = stays.some(function (s) { return s.city === f.toCity && nearRange(f.date, s); });
    if (covered) return;
    for (var j = i + 1; j < flights.length; j++) {
      var g = flights[j];
      if (g.fromCity === f.toCity && dayDiff(f.date, g.date) >= 1 && dayDiff(f.date, g.date) <= TRIP_GAP_DAYS) { // same-day = layover, not a trip
        stays.push({ city: f.toCity, start: f.date, end: g.date, note: 'from flights', tent: f.tent && g.tent, deny: false, src: f.src + ' + ' + g.src, explicit: false });
        log.push('INFERRED trip from flights: ' + f.toCity + ' ' + f.date + ' to ' + g.date);
        break;
      }
    }
  });

  // merge same-city stays that overlap or touch
  var byCity = {};
  stays.forEach(function (s) { (byCity[s.city] = byCity[s.city] || []).push(s); });
  var merged = [];
  Object.keys(byCity).forEach(function (c) {
    var arr = byCity[c].sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    var cur = null;
    arr.forEach(function (s) {
      if (cur && s.start <= cur.end) {
        log.push('MERGED duplicate/overlapping stay: ' + s.src + '  =  ' + cur.src);
        if (s.end > cur.end) cur.end = s.end;
        if (!cur.note && s.note) cur.note = s.note;
        cur.tent = cur.tent && s.tent;
      } else { if (cur) merged.push(cur); cur = { city: s.city, start: s.start, end: s.end, note: s.note, tent: s.tent, src: s.src }; }
    });
    if (cur) merged.push(cur);
  });

  var out = {};
  merged.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  merged.forEach(function (s) {
    if (s.tent && HIDE_TENTATIVE) { log.push('SKIPPED (tentative, HIDE_TENTATIVE is on): ' + s.city + ' ' + s.start); return; }
    var t = { who: WHO, place: s.city, start: s.start, end: s.end };
    var note = [s.note, s.tent ? 'tentative' : ''].filter(Boolean).join(', ');
    if (note) t.note = note;
    out['amy-' + s.start + '-' + s.city.toLowerCase().replace(/[^a-z0-9]+/g, '')] = t;
  });

  // attach each flight to the nearest trip, if during the trip or within 1 day of it
  var keys = Object.keys(out);
  flights.forEach(function (f) {
    var best = null, bestDist = 2;
    keys.forEach(function (k) {
      var s = out[k], d = f.date < s.start ? dayDiff(f.date, s.start) : (f.date > s.end ? dayDiff(s.end, f.date) : 0);
      if (d < bestDist) { best = k; bestDist = d; }
    });
    if (best) {
      var line = 'Fly ' + shortDate(f.date) + ': ' + (f.line || f.text) + (f.tent ? ' (tentative)' : '');
      out[best].flight = out[best].flight ? out[best].flight + ' | ' + line : line;
    } else log.push('UNATTACHED flight (no trip within a day, not published): ' + (f.line || f.text) + ' on ' + f.date);
  });

  keys.sort().forEach(function (k) {
    var t = out[k];
    log.push('WOULD PUBLISH: ' + t.place + ' ' + t.start + ' to ' + t.end + (t.note ? ' [' + t.note + ']' : '') + (t.flight ? '  ' + t.flight : ''));
  });
  return { out: out, log: log };
}

function explicitStay(e, title) {
  var parts = title.replace(/^trip:\s*/i, '').split(/\s+-\s+/);
  var place = parts[0].trim();
  return { city: resolveCity(place) || place, start: e.startYmd, end: e.endYmd, note: parts.slice(1).join(' - ').trim(), tent: TENTATIVE_RE.test(title), deny: false, src: title, explicit: true };
}

// A flight is a timed event with a carrier+number, a route like DCA -> BNA, a plane symbol, or "Flight/Fly to".
function parseFlight(e) {
  if (e.allDay) return null;
  var title = e.title.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  var loc = (e.location || '').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  var carrier = null, num = '';
  var m = title.match(/\b(WN|AA|DL|UA|B6|AS|NK|F9|G4|HA|AC)\s?(\d{1,4})\b/);
  if (m) { carrier = m[1]; num = m[2]; }
  else {
    m = title.match(/\b(southwest|american|delta|united|jetblue|alaska|spirit|frontier|allegiant|hawaiian)\b(?:\s+airlines?)?\s*#?(\d{1,4})?/i);
    if (m) { carrier = CARRIER_WORDS[m[1].toLowerCase()]; num = m[2] || ''; }
  }
  var route = title.match(/\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/) || loc.match(/\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/);
  var codes = [];
  if (route && AIRPORTS[route[1]] && AIRPORTS[route[2]]) codes = [route[1], route[2]];
  else {
    var cand = (title + ' ' + loc).match(/\b[A-Z]{3}\b/g) || [];
    cand.forEach(function (c) { if (AIRPORTS[c] && codes.indexOf(c) < 0) codes.push(c); });
  }
  var looksFlight = /✈/.test(title) || /\b(flight|fly)\b/i.test(title) || (carrier && (num || codes.length)) || codes.length === 2 && !!route;
  if (!looksFlight) return null;
  var from = codes[0] || null, to = codes[1] || null;
  if (!to) { // "Flight to Knoxville (AA 2544)": destination city after "to"
    var dm = title.match(/\b(?:to|→)\s+([A-Za-z .\/]+?)(?:\s*\(|$)/);
    var dc = dm ? resolveCity(dm[1]) : null;
    if (dc) to = primaryAirport(dc);
  }
  if (!to) { // "AA 4985 Santa Fe to Dallas/Ft Worth": both cities in the title
    var rm = title.match(/^(?:[A-Z0-9]{2}\s?\d{1,4}\s+)?(.+?)\s+to\s+(.+)$/);
    if (rm) { var c1 = resolveCity(rm[1]), c2 = resolveCity(rm[2]); if (c2) to = primaryAirport(c2); if (c1 && !from) from = primaryAirport(c1); }
  }
  var fromTz = (from && AIRPORTS[from]) ? AIRPORTS[from][1] : Session.getScriptTimeZone();
  var toTz = (to && AIRPORTS[to]) ? AIRPORTS[to][1] : Session.getScriptTimeZone();
  var line = '';
  if (carrier) line += (CARRIERS[carrier] || carrier) + (num ? ' ' + num : '');
  if (from) line += ' ' + from + ' ' + clock(e.start, fromTz);
  if (to) line += ' to ' + to + ' ' + clock(e.end, toTz);
  line = line.replace(/^\s+/, '');
  var hasId = (carrier && num) || (from && to);
  var f = { date: e.startYmd, startMs: e.start.getTime(), line: hasId ? line : '', from: from, to: to,
            fromCity: from && AIRPORTS[from] ? AIRPORTS[from][0] : null, toCity: to && AIRPORTS[to] ? AIRPORTS[to][0] : null };
  f.key = (carrier && num) ? 'N|' + carrier + num + '|' + e.startYmd : 'R|' + (from || '') + (to || '') + '|' + e.start.getTime();
  return f;
}
function richness(f) { return (f.from ? 1 : 0) + (f.to ? 1 : 0) + (f.line ? f.line.length / 100 : 0); }
function nearRange(date, s) { return (date >= s.start && date <= s.end) || dayDiff(date, s.start) === 1 || dayDiff(s.end, date) === 1; }

// ---------- cities ----------
var _aliasList = null;
function aliasList() {
  if (_aliasList) return _aliasList;
  var map = {};
  Object.keys(AIRPORTS).forEach(function (c) {
    var city = AIRPORTS[c][0];
    map[city.split(',')[0].toLowerCase()] = city;
  });
  Object.keys(CITY_ALIASES).forEach(function (city) { CITY_ALIASES[city].forEach(function (a) { map[a] = city; }); });
  _aliasList = Object.keys(map).sort(function (a, b) { return b.length - a.length; }).map(function (a) { return { a: a, city: map[a], re: new RegExp('(^|[^a-z0-9])' + a.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '($|[^a-z0-9])') }; });
  return _aliasList;
}
function resolveCity(text) {
  if (!text) return null;
  var s = text.toLowerCase();
  var list = aliasList();
  for (var i = 0; i < list.length; i++) if (list[i].re.test(s)) return list[i].city;
  return null;
}
function cityFromAddress(loc) { // "..., Knoxville, TN 37917" -> "Knoxville, TN" (city and state only, never the street)
  var m = (loc || '').match(/([A-Z][A-Za-z.' -]{2,}),\s*([A-Z]{2})\b/);
  return m ? m[1].trim() + ', ' + m[2] : null;
}
function primaryAirport(city) { var k = Object.keys(AIRPORTS); for (var i = 0; i < k.length; i++) if (AIRPORTS[k[i]][0] === city) return k[i]; return null; }

// ---------- date helpers ----------
function clock(d, tz) { return Utilities.formatDate(d, tz, 'h:mm a z'); }
function dayDiff(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 864e5); }
function ymd(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function shortDate(s) { var p = s.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1] - 1] + ' ' + (+p[2]); }
