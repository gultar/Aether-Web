'use strict';

// Small dependency-free iCalendar reader for BrowserOS' published Outlook feed.
// It intentionally keeps the published ICS URL on the Node side; callers receive
// normalized event objects only.

const DAY_MS = 86400000;

function unfoldIcs(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function splitContentLine(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

function parseProperty(line) {
  const [head, value] = splitContentLine(line);
  const bits = head.split(';');
  const name = String(bits.shift() || '').trim().toUpperCase();
  const params = {};
  for (const bit of bits) {
    const eq = bit.indexOf('=');
    if (eq < 0) continue;
    const key = bit.slice(0, eq).trim().toUpperCase();
    let val = bit.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

function decodeText(value) {
  return String(value || '')
    .replace(/\\[nN]/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function localDayOrdinal(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

function cloneAtDate(day, source) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), source.getHours(), source.getMinutes(), source.getSeconds(), source.getMilliseconds());
}


function parseOffsetMinutes(value) {
  const m = String(value || '').trim().match(/^([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return (m[1] === '-' ? -1 : 1) * minutes;
}

function rawDateParts(rawValue) {
  const raw = String(rawValue || '').trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null;
  return { y:Number(m[1]), mo:Number(m[2])-1, d:Number(m[3]), hh:Number(m[4]||0), mm:Number(m[5]||0), ss:Number(m[6]||0) };
}

function transitionForYear(component, year) {
  const base = rawDateParts(component.dtstart);
  if (!base) return null;
  const rule = component.rrule || {};
  const month = Number(rule.BYMONTH || base.mo + 1) - 1;
  let day = base.d;
  const byMonthDay = String(rule.BYMONTHDAY || '').split(',').map(x=>x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  if (byMonthDay.length) {
    const n=byMonthDay[0], last=new Date(year,month+1,0).getDate();
    day=n>0?n:last+n+1;
  } else {
    const byDay=parseByDay(rule.BYDAY);
    if(byDay.length){
      const spec=byDay[0];
      if(spec.ordinal!=null) day=nthWeekdayOfMonth(new Date(year,month,1),spec.weekday,spec.ordinal);
      else {
        const first=new Date(year,month,1);
        day=1+((spec.weekday-first.getDay()+7)%7);
      }
    }
  }
  return Date.UTC(year,month,day,base.hh,base.mm,base.ss);
}

function timezoneOffsetAtLocal(zones, tzid, parts) {
  if (!zones || !tzid || !zones.has(tzid)) return null;
  const zone=zones.get(tzid);
  const wall=Date.UTC(parts.y,parts.mo,parts.d,parts.hh,parts.mm,parts.ss);
  const transitions=[];
  for(const component of zone.components){
    for(const y of [parts.y-1,parts.y,parts.y+1]){
      const at=transitionForYear(component,y);
      if(at!=null && Number.isFinite(component.offsetTo))transitions.push({at,offset:component.offsetTo});
    }
  }
  transitions.sort((a,b)=>a.at-b.at);
  let selected=null;
  for(const transition of transitions){if(transition.at<=wall)selected=transition;else break;}
  if(selected)return selected.offset;
  const fallback=zone.components.find(x=>Number.isFinite(x.offsetTo));
  return fallback?fallback.offsetTo:null;
}

function parseVTimezones(unfolded) {
  const zones=new Map();
  const lines=String(unfolded||'').split('\n');
  let zone=null, component=null;
  for(const rawLine of lines){
    const line=rawLine.trimEnd();
    const upper=line.toUpperCase();
    if(upper==='BEGIN:VTIMEZONE'){zone={tzid:'',components:[]};continue;}
    if(upper==='END:VTIMEZONE'){
      if(zone?.tzid)zones.set(zone.tzid,zone);
      zone=null;component=null;continue;
    }
    if(!zone)continue;
    if(upper==='BEGIN:STANDARD'||upper==='BEGIN:DAYLIGHT'){component={kind:upper.slice(6),dtstart:'',rrule:null,offsetTo:null};continue;}
    if(upper==='END:STANDARD'||upper==='END:DAYLIGHT'){if(component)zone.components.push(component);component=null;continue;}
    const prop=parseProperty(line);
    if(!component && prop.name==='TZID')zone.tzid=decodeText(prop.value);
    if(component){
      if(prop.name==='DTSTART')component.dtstart=prop.value;
      else if(prop.name==='RRULE')component.rrule=parseRule(prop.value);
      else if(prop.name==='TZOFFSETTO')component.offsetTo=parseOffsetMinutes(prop.value);
    }
  }
  return zones;
}

function parseIcsDate(rawValue, params = {}, zones = null) {
  const raw = String(rawValue || '').trim();
  if (!raw) return null;
  const valueType = String(params.VALUE || '').toUpperCase();
  if (valueType === 'DATE' || /^\d{8}$/.test(raw)) {
    const m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0), allDay: true, tzid: params.TZID || '' };
  }

  const m = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{4})?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const hh = Number(m[4]), mm = Number(m[5]), ss = Number(m[6] || 0);
  const suffix = m[7] || '';
  let date;
  if (suffix === 'Z') {
    date = new Date(Date.UTC(y, mo, d, hh, mm, ss));
  } else if (/^[+-]\d{4}$/.test(suffix)) {
    const sign = suffix[0] === '-' ? -1 : 1;
    const offMin = sign * (Number(suffix.slice(1, 3)) * 60 + Number(suffix.slice(3, 5)));
    date = new Date(Date.UTC(y, mo, d, hh, mm, ss) - offMin * 60000);
  } else {
    const parts={y,mo,d,hh,mm,ss};
    const tzid=String(params.TZID||'');
    const offset=timezoneOffsetAtLocal(zones,tzid,parts);
    if(Number.isFinite(offset))date=new Date(Date.UTC(y,mo,d,hh,mm,ss)-offset*60000);
    else date = new Date(y, mo, d, hh, mm, ss, 0);
  }
  return { date, allDay: false, tzid: params.TZID || '' };
}

function parseRule(value) {
  const out = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return out;
}

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseByDay(value) {
  return String(value || '').split(',').map(token => {
    const m = token.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!m) return null;
    return { ordinal: m[1] ? Number(m[1]) : null, weekday: WEEKDAY[m[2]], token: m[2] };
  }).filter(Boolean);
}

function nthWeekdayOfMonth(date, weekday, ordinal) {
  const y = date.getFullYear(), m = date.getMonth();
  if (ordinal > 0) {
    const first = new Date(y, m, 1);
    const delta = (weekday - first.getDay() + 7) % 7;
    return 1 + delta + (ordinal - 1) * 7;
  }
  const last = new Date(y, m + 1, 0);
  const delta = (last.getDay() - weekday + 7) % 7;
  return last.getDate() - delta + (ordinal + 1) * 7;
}

function weekIndex(date, start, wkst = 1) {
  const startShift = (start.getDay() - wkst + 7) % 7;
  const dateShift = (date.getDay() - wkst + 7) % 7;
  const startWeek = localDayOrdinal(start) - startShift;
  const dateWeek = localDayOrdinal(date) - dateShift;
  return Math.floor((dateWeek - startWeek) / 7);
}

function monthIndex(date, start) {
  return (date.getFullYear() - start.getFullYear()) * 12 + date.getMonth() - start.getMonth();
}

function matchesRule(candidate, start, rule) {
  if (candidate < start) return false;
  const freq = String(rule.FREQ || '').toUpperCase();
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const byMonth = String(rule.BYMONTH || '').split(',').map(x=>x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  const byMonthDay = String(rule.BYMONTHDAY || '').split(',').map(x=>x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  const byDay = parseByDay(rule.BYDAY);

  if (byMonth.length && !byMonth.includes(candidate.getMonth() + 1)) return false;
  if (byMonthDay.length) {
    const last = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate();
    const valid = byMonthDay.some(n => n > 0 ? candidate.getDate() === n : candidate.getDate() === last + n + 1);
    if (!valid) return false;
  }

  if (freq === 'DAILY') {
    const days = localDayOrdinal(candidate) - localDayOrdinal(start);
    if (days < 0 || days % interval !== 0) return false;
    if (byDay.length && !byDay.some(x => x.weekday === candidate.getDay())) return false;
    return true;
  }

  if (freq === 'WEEKLY') {
    const wkst = WEEKDAY[String(rule.WKST || 'MO').toUpperCase()] ?? 1;
    const weeks = weekIndex(candidate, start, wkst);
    if (weeks < 0 || weeks % interval !== 0) return false;
    const allowed = byDay.length ? byDay.map(x => x.weekday) : [start.getDay()];
    return allowed.includes(candidate.getDay());
  }

  if (freq === 'MONTHLY') {
    const months = monthIndex(candidate, start);
    if (months < 0 || months % interval !== 0) return false;
    if (byDay.length) {
      return byDay.some(x => {
        if (x.weekday !== candidate.getDay()) return false;
        if (x.ordinal == null) return true;
        return candidate.getDate() === nthWeekdayOfMonth(candidate, x.weekday, x.ordinal);
      });
    }
    if (!byMonthDay.length) return candidate.getDate() === start.getDate();
    return true;
  }

  if (freq === 'YEARLY') {
    const years = candidate.getFullYear() - start.getFullYear();
    if (years < 0 || years % interval !== 0) return false;
    if (!byMonth.length && candidate.getMonth() !== start.getMonth()) return false;
    if (byDay.length) {
      return byDay.some(x => {
        if (x.weekday !== candidate.getDay()) return false;
        if (x.ordinal == null) return true;
        return candidate.getDate() === nthWeekdayOfMonth(candidate, x.weekday, x.ordinal);
      });
    }
    if (!byMonthDay.length) return candidate.getDate() === start.getDate();
    return true;
  }

  // Unsupported recurrence frequencies are intentionally not guessed.
  return false;
}

function eventFromProperties(props, zones) {
  const first = name => (props.get(name) || [])[0] || null;
  const dtStartProp = first('DTSTART');
  if (!dtStartProp) return null;
  const startParsed = parseIcsDate(dtStartProp.value, dtStartProp.params, zones);
  if (!startParsed) return null;
  const dtEndProp = first('DTEND');
  const endParsed = dtEndProp ? parseIcsDate(dtEndProp.value, dtEndProp.params, zones) : null;
  const duration = endParsed ? Math.max(0, endParsed.date - startParsed.date) : (startParsed.allDay ? DAY_MS : 3600000);
  const recurrenceProp = first('RECURRENCE-ID');
  const recurrenceParsed = recurrenceProp ? parseIcsDate(recurrenceProp.value, recurrenceProp.params, zones) : null;
  const exdates = [];
  for (const prop of props.get('EXDATE') || []) {
    for (const raw of String(prop.value || '').split(',')) {
      const parsed = parseIcsDate(raw, prop.params, zones);
      if (parsed) exdates.push(parsed.date.getTime());
    }
  }
  const status = decodeText(first('STATUS')?.value || '').toUpperCase();
  return {
    uid: decodeText(first('UID')?.value || ''),
    subject: decodeText(first('SUMMARY')?.value || '') || '(Untitled event)',
    location: decodeText(first('LOCATION')?.value || ''),
    description: decodeText(first('DESCRIPTION')?.value || ''),
    status,
    startDate: startParsed.date,
    endDate: new Date(startParsed.date.getTime() + duration),
    allDay: startParsed.allDay,
    tzid: startParsed.tzid,
    duration,
    rrule: first('RRULE') ? parseRule(first('RRULE').value) : null,
    exdates,
    recurrenceId: recurrenceParsed ? recurrenceParsed.date : null,
    url: decodeText(first('URL')?.value || ''),
  };
}

function parseRawEvents(text) {
  const unfolded = unfoldIcs(text);
  const zones = parseVTimezones(unfolded);
  if (!/BEGIN:VCALENDAR/i.test(unfolded)) throw new Error('The Outlook feed did not return a valid iCalendar document.');
  const lines = unfolded.split('\n');
  const events = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.toUpperCase() === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }
    if (line.toUpperCase() === 'END:VEVENT') {
      if (current) {
        const event = eventFromProperties(current, zones);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current || !line) continue;
    const prop = parseProperty(line);
    if (!prop.name) continue;
    if (!current.has(prop.name)) current.set(prop.name, []);
    current.get(prop.name).push(prop);
  }
  return events;
}

function occurrenceKey(uid, date) {
  return `${uid || ''}|${date.getTime()}`;
}

function normalizeOutput(event, startDate, endDate, sourceSuffix = '') {
  const id = `ics:${event.uid || 'event'}:${startDate.getTime()}${sourceSuffix}`;
  return {
    id,
    uid: event.uid || '',
    subject: event.subject,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    allDay: !!event.allDay,
    location: event.location || '',
    description: event.description || '',
    webLink: event.url || '',
    source: 'outlook-ics',
    readOnly: true,
  };
}

function parseIcsCalendar(text, options = {}) {
  const raw = parseRawEvents(text);
  const now = options.now instanceof Date ? options.now : new Date();
  const windowStart = options.windowStart instanceof Date ? options.windowStart : new Date(now.getFullYear() - 2, 0, 1);
  const windowEnd = options.windowEnd instanceof Date ? options.windowEnd : new Date(now.getFullYear() + 3, 0, 1);

  const overrides = new Map();
  for (const event of raw) {
    if (event.recurrenceId && event.uid) overrides.set(occurrenceKey(event.uid, event.recurrenceId), event);
  }

  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.uid}|${item.start}|${item.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const event of raw) {
    if (event.status === 'CANCELLED' || event.recurrenceId) continue;
    if (!event.rrule) {
      if (event.endDate >= windowStart && event.startDate <= windowEnd) push(normalizeOutput(event, event.startDate, event.endDate));
      continue;
    }

    const rule = event.rrule;
    const untilProp = rule.UNTIL ? parseIcsDate(rule.UNTIL, {}) : null;
    const until = untilProp?.date || null;
    const countLimit = Math.max(0, Number(rule.COUNT || 0));
    const exSet = new Set(event.exdates.map(Number));
    let occurrenceCount = 0;

    // Walk calendar days rather than milliseconds so DST transitions do not drift
    // recurring wall-clock times. A five-year safety horizon is still only ~1,826
    // cheap iterations per recurring event.
    const lastDay = until && until < windowEnd ? until : windowEnd;
    const day = new Date(event.startDate.getFullYear(), event.startDate.getMonth(), event.startDate.getDate());
    const maxIterations = 366 * 12;
    for (let i = 0; i < maxIterations && day <= lastDay; i++, day.setDate(day.getDate() + 1)) {
      const candidate = cloneAtDate(day, event.startDate);
      if (until && candidate > until) break;
      if (!matchesRule(candidate, event.startDate, rule)) continue;
      occurrenceCount++;
      if (countLimit && occurrenceCount > countLimit) break;
      if (exSet.has(candidate.getTime())) continue;
      const override = overrides.get(occurrenceKey(event.uid, candidate));
      if (override) {
        if (override.status !== 'CANCELLED' && override.endDate >= windowStart && override.startDate <= windowEnd) {
          push(normalizeOutput(override, override.startDate, override.endDate, ':override'));
        }
        continue;
      }
      const end = new Date(candidate.getTime() + event.duration);
      if (end >= windowStart && candidate <= windowEnd) push(normalizeOutput(event, candidate, end, ':rec'));
    }
  }

  // Some feeds include detached recurrence overrides without the master event.
  for (const event of raw) {
    if (!event.recurrenceId || event.status === 'CANCELLED') continue;
    const key = `${event.uid}|${event.startDate.toISOString()}|${event.subject}`;
    if (!seen.has(key) && event.endDate >= windowStart && event.startDate <= windowEnd) {
      push(normalizeOutput(event, event.startDate, event.endDate, ':detached'));
    }
  }

  out.sort((a, b) => String(a.start).localeCompare(String(b.start)) || String(a.subject).localeCompare(String(b.subject)));
  return out;
}

function parseBoundary(value, isEnd = false) {
  const raw=String(value||'').trim();
  const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),isEnd?23:0,isEnd?59:0,isEnd?59:0,isEnd?999:0);
  const d=raw?new Date(raw):null;
  return d&&Number.isFinite(d.getTime())?d:null;
}

function filterEvents(events, startValue, endValue) {
  const start = parseBoundary(startValue, false);
  const end = parseBoundary(endValue, true);
  if (!start && !end) return events;
  return events.filter(event => {
    const s = new Date(event.start), e = new Date(event.end || event.start);
    if (Number.isNaN(s.getTime())) return false;
    if (start && e < start) return false;
    if (end && s > end) return false;
    return true;
  });
}

module.exports = { parseIcsCalendar, filterEvents, parseIcsDate, parseRule, decodeText, matchesRule, parseVTimezones, timezoneOffsetAtLocal };
