from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
import subprocess
import shutil
import socket
import ipaddress
from html.parser import HTMLParser
from datetime import datetime, timedelta
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import difflib
from pathlib import Path, PureWindowsPath
from typing import Any, Callable

import yaml

from research_pipeline import build_evidence_pack

BROWSER_OS_URL = os.environ.get('BROWSER_OS_URL', 'http://127.0.0.1:8001').rstrip('/')
TOOL_ROOT = Path(__file__).resolve().parent / 'os_tools'
DEFINITION_DIR = TOOL_ROOT / 'definitions'
GENERATED_DIR = TOOL_ROOT / 'generated'
_NAME_RE = re.compile(r'^[a-z][a-z0-9_]{1,63}$')
_TOOL_LOCK = threading.RLock()
PROJECT_ROOT = Path(__file__).resolve().parents[2]
AGENT_BACKUP_ROOT = PROJECT_ROOT / '.browser-os-agent-backups'
PROJECT_AGENT_IGNORED_DIRS = {'node_modules', '.git', '.browser-os-agent-backups', '__pycache__'}
PROJECT_AGENT_TEXT_EXTS = {'.js','.mjs','.cjs','.json','.html','.css','.py','.md','.txt','.yaml','.yml'}



def _request(path: str, *, method: str = 'GET', body: dict[str, Any] | None = None, timeout: float = 4) -> Any:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BROWSER_OS_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=max(1, float(timeout))) as response:
            raw = response.read().decode('utf-8', errors='replace')
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', errors='replace')
        raise RuntimeError(detail or f'Browser-OS HTTP {error.code}') from error


def _command(action: str, **args: Any) -> str:
    result = _request('/api/os/command', method='POST', body={'action': action, 'args': args})
    if not result.get('ok'):
        raise RuntimeError(result.get('error') or 'Browser-OS rejected command')
    return result.get('message') or 'Command sent to Browser-OS.'


def browser_window(action: str, target: str) -> str:
    return _command('window', window_action=action, target=target)


def browser_system_info() -> str:
    result = _request('/api/system')
    cpu = result.get('cpu', {})
    mem = result.get('memory', {})
    gpu = result.get('gpu', {})
    return json.dumps({
        'cpu_percent': cpu.get('load'),
        'ram_percent': (round((float(mem.get('used') or 0) / float(mem.get('total') or 1)) * 100, 1) if mem.get('total') else None),
        'ram_used': mem.get('used'),
        'ram_total': mem.get('total'),
        'gpu_percent': (gpu or {}).get('utilization'),
        'vram_percent': (round((float((gpu or {}).get('memoryUsedMb') or 0) / float((gpu or {}).get('memoryTotalMb') or 1)) * 100, 1) if (gpu or {}).get('memoryTotalMb') else None),
        'uptime': result.get('uptime'),
    }, ensure_ascii=False)


def browser_calendar(action: str = 'list', title: str = '', start: str = '', end: str = '', event_id: str = '', query: str = '', location: str = '', all_day: bool = False, period: str = '', sync_with_outlook: bool = True) -> str:
    """List the merged BrowserOS/Outlook calendar or create either a local-only or Outlook-synced event."""
    action = str(action or 'list').strip().lower()
    action = {'create':'add','update':'edit','delete':'remove','search':'list'}.get(action, action)
    if action not in {'list','add','edit','remove'}:
        raise ValueError('action must be one of: list, add, edit, remove')

    def get_events(*, fresh: bool = False, timeout: float = 45, lo: str = '', hi: str = '') -> list[dict[str, Any]]:
        if fresh:
            params={'refresh':'1'}
            if str(lo or '').strip(): params['start']=str(lo).strip()
            if str(hi or '').strip(): params['end']=str(hi).strip()
            path='/api/outlook/events?' + urllib.parse.urlencode(params)
        else:
            path='/api/outlook/events/cache'
        data = _request(path, timeout=timeout)
        events = data.get('events', []) if isinstance(data, dict) else []
        return [e for e in events if isinstance(e, dict)]

    def normalize_calendar_text(value: Any) -> str:
        text = unicodedata.normalize('NFKD', str(value or ''))
        text = ''.join(ch for ch in text if not unicodedata.combining(ch))
        text = text.replace('’', "'").replace('‘', "'").replace('`', "'").replace('´', "'")
        text = text.replace('–', '-').replace('—', '-')
        text = re.sub(r"[^a-zA-Z0-9]+", ' ', text.casefold())
        return ' '.join(text.split())

    def event_text(e: dict[str, Any]) -> str:
        return normalize_calendar_text(f"{e.get('subject') or ''} {e.get('location') or ''}")

    def in_bounds(e: dict[str, Any], lo: str = '', hi: str = '') -> bool:
        value = str(e.get('start') or '').strip()
        lo = str(lo or '').strip()
        hi = str(hi or '').strip()
        event_day = value[:10] if re.match(r'^\d{4}-\d{2}-\d{2}', value) else ''

        # Small models often express a requested local calendar day as a UTC-looking
        # 00:00:00Z -> 23:59:59Z range. Outlook bridge event timestamps are local/naive,
        # so comparing those strings directly can exclude the correct event. Treat a
        # same-date full-day range as that calendar day regardless of the trailing Z.
        lo_day = lo[:10] if re.match(r'^\d{4}-\d{2}-\d{2}', lo) else ''
        hi_day = hi[:10] if re.match(r'^\d{4}-\d{2}-\d{2}', hi) else ''
        full_day_range = bool(
            lo_day and hi_day and lo_day == hi_day
            and (re.fullmatch(r'\d{4}-\d{2}-\d{2}', lo) or 'T00:00:00' in lo)
            and (re.fullmatch(r'\d{4}-\d{2}-\d{2}', hi) or ('T23:59:59' in hi or 'T23:59' in hi))
        )
        # Date-only start/end values represent calendar bounds. When they are the
        # same date this is a single-day filter; when they differ this is an inclusive
        # range (for example Monday through Sunday).
        lo_is_date = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', lo))
        hi_is_date = bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', hi))
        if lo_is_date and hi_is_date:
            if not event_day:
                return False
            if lo == hi:
                return event_day == lo
            return lo <= event_day <= hi

        if full_day_range:
            return event_day == lo_day

        if lo:
            if lo_is_date:
                if event_day != lo:
                    return False
            else:
                # Normalize a trailing Z only for comparison with the bridge's naive
                # local timestamps. This is intentionally not timezone conversion.
                lo_cmp = lo[:-1] if lo.endswith('Z') else lo
                value_cmp = value[:-1] if value.endswith('Z') else value
                if value_cmp < lo_cmp:
                    return False
        if hi:
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}', hi):
                if event_day > hi:
                    return False
            else:
                hi_cmp = hi[:-1] if hi.endswith('Z') else hi
                value_cmp = value[:-1] if value.endswith('Z') else value
                if value_cmp > hi_cmp:
                    return False
        return True

    def filter_events(events: list[dict[str, Any]], *, text: str = '', lo: str = '', hi: str = '') -> list[dict[str, Any]]:
        needle = normalize_calendar_text(text)
        out = events
        if needle:
            out = [e for e in out if needle in event_text(e)]
        if lo or hi:
            out = [e for e in out if in_bounds(e, lo, hi)]
        return out

    def compact(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [{
            'id': e.get('id') or '', 'title': e.get('subject') or '', 'start': e.get('start') or '',
            'end': e.get('end') or '', 'location': e.get('location') or '', 'all_day': bool(e.get('allDay')),
            'source': e.get('source') or '', 'synced_with_outlook': e.get('source') != 'browseros-local'
        } for e in events[:40]]

    def resolve_current() -> dict[str, Any]:
        if str(event_id or '').strip():
            # Prefer the cache first; it is normally populated by the visible Agenda and avoids
            # launching a second Playwright browser merely to resolve an already-known event.
            events = get_events(fresh=False, timeout=4)
            found = next((e for e in events if str(e.get('id') or '') == str(event_id)), None)
            if found is not None:
                return found
            events = get_events(fresh=True, timeout=75)
            found = next((e for e in events if str(e.get('id') or '') == str(event_id)), None)
            if found is not None:
                return found
            raise ValueError('event_id was not found in the current Outlook calendar')

        # Resolve natural edit/remove requests by DAY first, then by title.
        # Free-text query is ignored when an explicit title is present; small models often
        # add words such as "tomorrow" that should not participate in title matching.
        needle = str(title or query or '').strip()
        if not needle:
            raise ValueError(f'event_id or title is required for {action}')
        lo, hi = str(start or ''), str(end or '')

        def candidates_for(events):
            # First constrain by requested calendar day/time window only.
            day_events = filter_events(events, lo=lo, hi=hi) if (lo or hi) else list(events)
            wanted = normalize_calendar_text(needle)
            # Exact normalized subject match is preferred.
            exact = [e for e in day_events if normalize_calendar_text(e.get('subject')) == wanted]
            if exact:
                return exact, day_events
            # Then accept subject containment (but do not let location text create a false match).
            contained = [e for e in day_events if wanted and (wanted in normalize_calendar_text(e.get('subject')) or normalize_calendar_text(e.get('subject')) in wanted)]
            if contained:
                return contained, day_events
            # Conservative fuzzy fallback for tiny-model typos/punctuation differences.
            scored=[]
            for e in day_events:
                subj=normalize_calendar_text(e.get('subject'))
                if not subj or not wanted:
                    continue
                score=difflib.SequenceMatcher(None, wanted, subj).ratio()
                if score >= 0.72:
                    scored.append((score,e))
            if scored:
                best=max(x[0] for x in scored)
                return [e for score,e in scored if score >= best-0.04], day_events
            return [], day_events

        cached = get_events(fresh=False, timeout=4)
        events, day_events = candidates_for(cached)
        if not events:
            fresh = get_events(fresh=True, timeout=75, lo=lo, hi=hi)
            events, day_events = candidates_for(fresh)
        if len(events) == 1:
            return events[0]
        if not events:
            seen=[{
                'id':e.get('id') or '',
                'title':e.get('subject') or '',
                'start':e.get('start') or '',
                'end':e.get('end') or ''
            } for e in day_events[:12]]
            raise ValueError('No Outlook event title matched on the requested day. Events seen that day: ' + json.dumps(seen, ensure_ascii=False))

        # If the user asks to remove one event and Outlook contains true duplicates
        # (same normalized title and exact same start/end), either copy is equivalent.
        # Remove exactly one and report how many duplicates were present. Editing remains
        # intentionally ambiguous because choosing one copy could matter.
        if action == 'remove':
            fingerprints = {
                (normalize_calendar_text(e.get('subject')), str(e.get('start') or ''), str(e.get('end') or ''), bool(e.get('allDay')))
                for e in events
            }
            if len(fingerprints) == 1:
                chosen = dict(events[0])
                chosen['_duplicate_count'] = len(events)
                return chosen

        raise ValueError('Multiple Outlook events matched; retry with event_id from these candidates: ' + json.dumps(compact(events), ensure_ascii=False))

    if action == 'list':
        # Keep temporal intent separate from title/location search. Tiny models often put
        # words such as "tomorrow" or an ISO range in query; interpret those as dates
        # rather than searching event titles for the literal words.
        q = str(query or '').strip()
        list_start = str(start or '').strip()
        list_end = str(end or '').strip()
        requested_period = str(period or '').strip().lower().replace('-', '_').replace(' ', '_')
        today = datetime.now().date()

        aliases = {
            'today': 'today', 'aujourd_hui': 'today', "aujourd'hui": 'today',
            'tomorrow': 'tomorrow', 'demain': 'tomorrow',
            'this_week': 'this_week', 'cette_semaine': 'this_week',
            'next_week': 'next_week', 'semaine_prochaine': 'next_week',
            'next_7_days': 'next_7_days', 'next7days': 'next_7_days',
        }
        q_key = normalize_calendar_text(q).replace(' ', '_')
        if not requested_period and q_key in aliases:
            requested_period = aliases[q_key]
            q = ''

        range_match = re.fullmatch(
            r'\s*(\d{4}-\d{2}-\d{2})\s*(?:TO|THROUGH|THRU|\.\.|->|–|—|-)\s*(\d{4}-\d{2}-\d{2})\s*',
            q, flags=re.I
        )
        if not list_start and range_match:
            list_start, list_end = range_match.group(1), range_match.group(2)
            q = ''
        elif not list_start and re.fullmatch(r'\d{4}-\d{2}-\d{2}', q):
            list_start = q
            list_end = q
            q = ''

        if requested_period and requested_period != 'custom' and not list_start:
            if requested_period == 'today':
                lo = hi = today
            elif requested_period == 'tomorrow':
                lo = hi = today + timedelta(days=1)
            elif requested_period == 'this_week':
                lo = today - timedelta(days=today.weekday())
                hi = lo + timedelta(days=6)
            elif requested_period == 'next_week':
                lo = today - timedelta(days=today.weekday()) + timedelta(days=7)
                hi = lo + timedelta(days=6)
            elif requested_period == 'next_7_days':
                lo = today
                hi = today + timedelta(days=6)
            else:
                raise ValueError('period must be one of: today, tomorrow, this_week, next_week, next_7_days, custom')
            list_start, list_end = lo.isoformat(), hi.isoformat()

        # A single explicit start date means one calendar day for list operations.
        if list_start and not list_end and re.fullmatch(r'\d{4}-\d{2}-\d{2}', list_start):
            list_end = list_start

        events = filter_events(
            get_events(fresh=True, timeout=75, lo=list_start, hi=list_end),
            text=(q or title), lo=list_start, hi=list_end
        )
        return json.dumps({
            'count': len(events),
            'range': {'start': list_start, 'end': list_end} if (list_start or list_end) else None,
            'query': q or str(title or '').strip(),
            'events': compact(events)
        }, ensure_ascii=False)

    if action == 'add':
        if not str(title or '').strip() or not str(start or '').strip():
            raise ValueError('title and start are required for add')
        payload = {
            'subject': str(title).strip(), 'start': str(start).strip(), 'end': str(end or start).strip(),
            'location': str(location or '').strip(), 'allDay': bool(all_day),
        }
        if not bool(sync_with_outlook):
            data = _request('/api/calendar/local-events', method='POST', timeout=10, body=payload)
            if not data.get('ok'):
                raise RuntimeError(data.get('error') or 'Local BrowserOS event creation failed')
            return f'Created local BrowserOS event (not synced with Outlook): {title}'
        payload['autoSave'] = True
        data = _request('/api/outlook/events', method='POST', timeout=60, body=payload)
        if not data.get('ok'):
            raise RuntimeError(data.get('error') or 'Outlook event creation failed')
        request_id = str(data.get('automationRequestId') or '').strip()
        if data.get('pendingAutomation') and request_id:
            deadline = time.monotonic() + 50.0
            last_status = ''
            while time.monotonic() < deadline:
                time.sleep(0.8)
                try:
                    state = _request('/api/outlook/automation/result/' + urllib.parse.quote(request_id), timeout=5)
                except Exception:
                    continue
                last_status = str(state.get('status') or '')
                if last_status == 'saved':
                    return f'Created and saved Outlook event: {title}'
                if last_status == 'failed':
                    detail = str(state.get('error') or state.get('detail') or 'automatic Save failed')
                    return f'Opened the Outlook event, but BrowserOS could not confirm automatic Save: {detail}'
            return f'Opened the Outlook event and requested automatic Save, but confirmation timed out. Check the Outlook tab before claiming the event is saved.'
        return data.get('message') or f'Opened Outlook event draft: {title}'

    current = resolve_current()
    resolved_id = str(current.get('id') or '').strip()
    if not resolved_id:
        raise ValueError('Matched Outlook event has no usable id')

    if action == 'edit':
        payload = {
            'id': resolved_id,
            'originalSubject': str(current.get('subject') or ''),
            'webLink': str(current.get('webLink') or ''),
            'subject': str(title or current.get('subject') or '').strip(),
            'start': str(start or current.get('start') or '').strip(),
            'end': str(end or current.get('end') or start or current.get('start') or '').strip(),
            'location': str(location if location != '' else current.get('location') or '').strip(),
            'allDay': bool(all_day if all_day else current.get('allDay', False)),
        }
        data = _request('/api/outlook/events/update', method='POST', timeout=60, body=payload)
        if not data.get('ok'):
            raise RuntimeError(data.get('error') or 'Outlook event update failed')
        return data.get('message') or 'Outlook event updated.'

    data = _request('/api/outlook/events/delete', method='POST', timeout=90, body={
        'id': resolved_id, 'subject': str(current.get('subject') or ''), 'webLink': str(current.get('webLink') or '')
    })
    if not data.get('ok'):
        raise RuntimeError(data.get('error') or 'Outlook event deletion failed')
    duplicate_count = int(current.get('_duplicate_count') or 0)
    if duplicate_count > 1:
        return f'Removed one of {duplicate_count} identical Outlook events; {duplicate_count - 1} duplicate(s) may remain.'
    return data.get('message') or 'Outlook event removed.'


def browser_note(text: str, mode: str = 'append') -> str:
    return _command('note', text=text, mode=mode)


def browser_todo(text: str) -> str:
    return _command('todo', text=text)


def browser_timer(duration: str, label: str = 'Timer') -> str:
    return _command('timer', duration=duration, label=label)


def browser_research(query: str) -> str:
    query = str(query or '').strip()
    if not query:
        return 'Research query is required.'
    evidence, sources, meta = build_evidence_pack(query, source_count=3, max_evidence_tokens=1200)
    source_lines = []
    for idx, source in enumerate(sources, start=1):
        data = source.public_dict()
        source_lines.append(f"[{idx}] {data.get('title') or data.get('domain') or 'Source'} — {data.get('url') or ''}")
    header = f"RESEARCH EVIDENCE ({len(sources)} sources; ~{meta.get('evidence_tokens', 'unknown')} tokens)"
    return header + "\n" + "\n".join(source_lines) + "\n\n" + evidence



class _ReadableHTML(HTMLParser):
    _HARD_SKIP = {'script','style','noscript','svg','nav','footer','form','aside'}
    _BLOCKS = {'p','div','section','article','main','li','h1','h2','h3','h4','pre','code','br','tr'}
    _LINK_NOISE = {
        'home','menu','sign in','sign up','subscribe','privacy','terms','cookies',
        'skip to content','next','previous','back to top','advertisement','ads'
    }

    def __init__(self, base_url: str = '', max_links: int = 24):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.base_url = str(base_url or '')
        self.max_links = max(0, int(max_links or 0))
        self.link_count = 0
        self.seen_links: set[str] = set()
        self._anchor_href: str | None = None
        self._anchor_text: list[str] = []

    def _resolve_link(self, href: str) -> str:
        value = str(href or '').strip()
        if not value or value.startswith(('#','javascript:','mailto:','tel:','data:')):
            return ''
        absolute = urllib.parse.urljoin(self.base_url, value)
        parsed = urllib.parse.urlparse(absolute)
        if parsed.scheme not in {'http','https'} or not parsed.hostname:
            return ''
        # Fragments add noise and rarely help the model choose another page.
        return urllib.parse.urlunparse(parsed._replace(fragment=''))

    def _flush_anchor(self):
        if self._anchor_href is None:
            return
        text = ' '.join(''.join(self._anchor_text).split()).strip()
        href = self._anchor_href
        self._anchor_href = None
        self._anchor_text = []
        if not text:
            return
        lowered = text.lower().strip(' .:–—-')
        useful = (
            bool(href)
            and len(text) >= 3
            and lowered not in self._LINK_NOISE
            and self.link_count < self.max_links
            and href not in self.seen_links
        )
        if useful:
            safe_text = text.replace('[','').replace(']','')
            self.parts.append(f'[{safe_text}]({href})')
            self.seen_links.add(href)
            self.link_count += 1
        else:
            self.parts.append(text)

    def handle_starttag(self, tag, attrs):
        tag = str(tag or '').lower()
        if tag in self._HARD_SKIP:
            if self._anchor_href is not None:
                self._flush_anchor()
            self.skip += 1
            return
        if self.skip:
            return
        if tag == 'a':
            if self._anchor_href is not None:
                self._flush_anchor()
            href = dict(attrs or []).get('href','')
            self._anchor_href = self._resolve_link(href)
            self._anchor_text = []
            return
        if tag in self._BLOCKS:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        tag = str(tag or '').lower()
        if tag in self._HARD_SKIP and self.skip:
            self.skip -= 1
            return
        if self.skip:
            return
        if tag == 'a':
            self._flush_anchor()
            return
        if tag in self._BLOCKS:
            self.parts.append('\n')

    def handle_data(self, data):
        if self.skip:
            return
        if self._anchor_href is not None:
            self._anchor_text.append(data)
        else:
            self.parts.append(data)

    def text(self):
        self._flush_anchor()
        raw=''.join(self.parts)
        lines=[' '.join(line.split()) for line in raw.splitlines()]
        return '\n'.join(line for line in lines if line)

def _public_url(url: str) -> str:
    value=str(url or '').strip()
    parsed=urllib.parse.urlparse(value)
    if parsed.scheme not in {'http','https'} or not parsed.hostname:
        raise ValueError('Only public http/https URLs are allowed.')
    host=parsed.hostname.lower().rstrip('.')
    if host in {'localhost','localhost.localdomain'} or host.endswith('.local'):
        raise ValueError('Local/private URLs are not allowed.')
    try:
        for info in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme=='https' else 80), type=socket.SOCK_STREAM):
            addr=ipaddress.ip_address(info[4][0])
            if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_multicast:
                raise ValueError('Local/private URLs are not allowed.')
    except socket.gaierror as error:
        raise ValueError(f'Could not resolve URL host: {host}') from error
    return value

def _trim_readable_text(text: str, limit: int) -> str:
    text=str(text or '').strip()
    if len(text) <= limit:
        return text
    cut=text[:limit]
    # Never leave an inline Markdown link half-written. If the character cap lands
    # inside [anchor](URL), discard that final link instead of returning a broken URL.
    last_link_start=cut.rfind('[')
    last_link_close=cut.rfind(')')
    if last_link_start > last_link_close:
        tail=cut[last_link_start:]
        if '](' in tail:
            cut=cut[:last_link_start].rstrip()
    # Prefer a natural boundary near the limit so the model receives complete text.
    floor=max(0, int(limit * 0.78))
    candidates=[cut.rfind('\n', floor), cut.rfind('. ', floor), cut.rfind(' ', floor)]
    boundary=max(candidates)
    if boundary >= floor:
        cut=cut[:boundary + (1 if cut[boundary:boundary+2]=='. ' else 0)].rstrip()
    return cut + '\n[Content truncated]'

def _fetch_text(url: str, limit: int = 7000) -> tuple[str,str]:
    url=_public_url(url)
    req=urllib.request.Request(url, headers={'User-Agent':'Browser-OS-Agent/1.0','Accept':'text/html,text/plain,text/markdown,application/json;q=0.8,*/*;q=0.5'})
    with urllib.request.urlopen(req, timeout=12) as response:
        final=_public_url(response.geturl())
        raw=response.read(1_000_000)
        ctype=str(response.headers.get('Content-Type') or '').lower()
    text=raw.decode('utf-8', errors='replace')
    if 'html' in ctype or '<html' in text[:500].lower():
        parser=_ReadableHTML(base_url=final); parser.feed(text); text=parser.text()
    else:
        text=text.replace('\r\n','\n').replace('\r','\n')
    return final, _trim_readable_text(text,limit)

def browser_read_url(url: str, max_chars: int = 7000) -> str:
    """Read a public URL, with GitHub repository roots optimized for README retrieval."""
    limit=max(1000,min(int(max_chars or 7000),12000))
    value=str(url or '').strip()
    parsed=urllib.parse.urlparse(value)
    # A repository root is much more useful to a small model as raw README text than
    # as GitHub's navigation-heavy HTML shell. Try common default branches first.
    if parsed.hostname and parsed.hostname.lower()=='github.com':
        parts=[p for p in parsed.path.split('/') if p]
        if len(parts)==2:
            owner,repo=parts
            for branch in ('main','master'):
                raw=f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/README.md'
                try:
                    final,text=_fetch_text(raw,limit)
                    if text:
                        return f'SOURCE URL: {final}\n\n{text}'
                except Exception:
                    pass
        if len(parts)>=5 and parts[2]=='blob':
            owner,repo,_,branch,*rest=parts
            raw='https://raw.githubusercontent.com/'+owner+'/'+repo+'/'+branch+'/'+'/'.join(rest)
            final,text=_fetch_text(raw,limit)
            return f'SOURCE URL: {final}\n\n{text}'
    final,text=_fetch_text(value,limit)
    return f'SOURCE URL: {final}\n\n{text or "[No readable page text]"}'

def _project_path(path_text: str, *, must_exist: bool = False, for_write: bool = False) -> Path:
    """Resolve an agent-supplied path strictly inside Browser-OS.

    Agent tools intentionally accept project-relative paths only.  The model cannot
    name C:\\Windows, another drive, a UNC share, or escape with ``..``.  Existing
    symlinks/junctions are resolved before the containment check, so a link placed
    inside the project cannot be used as a tunnel to the rest of Windows.
    """
    root = PROJECT_ROOT.resolve(strict=True)
    raw = str(path_text or '').strip().replace('\\', '/')

    # Be forgiving when the model repeats the visible project-folder name.
    root_name = root.name
    if raw == root_name:
        raw = '.'
    elif raw.startswith(root_name + '/'):
        raw = raw[len(root_name) + 1:]

    # Reject every form of absolute Windows/POSIX path before joining to the root.
    win = PureWindowsPath(raw)
    if Path(raw).is_absolute() or win.is_absolute() or win.drive or raw.startswith('//'):
        raise PermissionError('Absolute paths are forbidden; use a Browser-OS project-relative path.')

    candidate = root if not raw or raw in {'.', './'} else root / raw
    path = candidate.resolve(strict=False)
    try:
        rel = path.relative_to(root)
    except ValueError as error:
        raise PermissionError('Path escapes the Browser-OS project root.') from error

    # Backups are recovery data, not an agent-editable part of the project.
    if for_write and rel.parts and rel.parts[0].lower() == AGENT_BACKUP_ROOT.name.lower():
        raise PermissionError('Agent backup files are protected from agent writes.')

    # Windows junctions/reparse points deserve an explicit guard in addition to
    # resolve(); isjunction() exists in Python 3.12+. Symlinks are guarded too.
    current = root
    for part in rel.parts:
        current = current / part
        if current.exists():
            if current.is_symlink():
                raise PermissionError('Writing through symlinks is forbidden.')
            if hasattr(os.path, 'isjunction') and os.path.isjunction(current):
                raise PermissionError('Writing through Windows junctions is forbidden.')

    if must_exist and not path.exists():
        raise FileNotFoundError(str(rel))
    return path

def _backup_file(path: Path) -> str | None:
    if not path.exists() or not path.is_file():
        return None
    stamp=datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    rel=path.relative_to(PROJECT_ROOT)
    dest=AGENT_BACKUP_ROOT/stamp/rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path,dest)
    return str(dest.relative_to(PROJECT_ROOT))

def _agent_visible_project_path(path: Path) -> bool:
    try:
        rel = path.relative_to(PROJECT_ROOT)
    except ValueError:
        return False
    return not any(part in PROJECT_AGENT_IGNORED_DIRS for part in rel.parts)

def browser_project_list(path: str = '.', pattern: str = '*') -> str:
    base=_project_path(path,must_exist=True)
    if not base.is_dir():
        raise ValueError('path must be a directory')
    pattern=str(pattern or '*').strip() or '*'
    rows=[]
    # Dependency/cache trees are intentionally invisible to the coding agent.
    # They are regenerated from package.json/package-lock.json and overwhelm a small model.
    for item in sorted(base.glob(pattern)):
        if not _agent_visible_project_path(item):
            continue
        try: rel=item.relative_to(PROJECT_ROOT)
        except ValueError: continue
        rows.append(('DIR  ' if item.is_dir() else 'FILE ')+rel.as_posix())
        if len(rows) >= 120:
            break
    return '\n'.join(rows) or '[No matches]'

def browser_project_read(path: str, max_chars: int = 6000, start_char: int = 0) -> str:
    file=_project_path(path,must_exist=True)
    if not file.is_file(): raise ValueError('path must be a file')
    if not _agent_visible_project_path(file):
        raise PermissionError('This dependency/cache path is intentionally hidden from the development agent.')
    if file.stat().st_size>2_000_000: raise ValueError('File is too large for agent reading. Use browser_project_find to locate relevant code first.')
    text=file.read_text(encoding='utf-8',errors='replace')
    limit=max(1000,min(int(max_chars or 6000),12000))
    start=max(0,int(start_char or 0))
    if start >= len(text) and text:
        raise ValueError(f'start_char is beyond end of file ({len(text)} characters).')
    end=min(len(text),start+limit)
    rel=file.relative_to(PROJECT_ROOT).as_posix()
    more=end < len(text)
    suffix=(f'\n\n[TRUNCATED: next start_char={end}; total_chars={len(text)}]' if more else f'\n\n[END OF FILE; total_chars={len(text)}]')
    return f'FILE: {rel} | chars {start}:{end}\n\n{text[start:end]}{suffix}'

def browser_project_find(query: str, path: str = '.', max_matches: int = 20) -> str:
    query=str(query or '').strip()
    if not query:
        raise ValueError('query is required')
    base=_project_path(path,must_exist=True)
    needle=query.lower()
    limit=max(1,min(int(max_matches or 20),50))
    rows=[]

    # `path` may be either a directory or one specific source file. This keeps
    # small-model tool use forgiving and avoids forcing a whole-project search
    # when the agent already knows which file it needs.
    candidates = [base] if base.is_file() else base.rglob('*')
    for file in candidates:
        if len(rows) >= limit:
            break
        if not file.is_file() or not _agent_visible_project_path(file) or file.suffix.lower() not in PROJECT_AGENT_TEXT_EXTS:
            continue
        try:
            if file.stat().st_size > 1_000_000:
                continue
            text=file.read_text(encoding='utf-8',errors='replace')
        except OSError:
            continue
        for line_no,line in enumerate(text.splitlines(),start=1):
            if needle in line.lower():
                rel=file.relative_to(PROJECT_ROOT).as_posix()
                preview=line.strip()[:240]
                rows.append(f'{rel}:{line_no}: {preview}')
                if len(rows) >= limit:
                    break
    return '\n'.join(rows) or '[No matches]'

def browser_project_replace(path: str, old: str, new: str, replace_all: bool = False) -> str:
    file=_project_path(path,must_exist=True,for_write=True)
    if not file.is_file(): raise ValueError('path must be a file')
    text=file.read_text(encoding='utf-8',errors='strict')
    old=str(old)
    if not old: raise ValueError('old text is required')
    count=text.count(old)
    if count==0: return 'No changes: exact old text was not found.'
    if count>1 and not replace_all: return f'No changes: exact old text occurs {count} times; make the match more specific or set replace_all=true.'
    backup=_backup_file(file)
    updated=text.replace(old,str(new)) if replace_all else text.replace(old,str(new),1)
    file.write_text(updated,encoding='utf-8')
    return f'Updated {file.relative_to(PROJECT_ROOT).as_posix()} ({count if replace_all else 1} replacement). Backup: {backup}'

def browser_project_write(path: str, content: str, overwrite: bool = False) -> str:
    file=_project_path(path,must_exist=False,for_write=True)
    if file.exists() and not overwrite:
        return 'No changes: file already exists. Read it first, then use browser_project_replace or explicitly set overwrite=true.'
    backup=_backup_file(file) if file.exists() else None
    file.parent.mkdir(parents=True,exist_ok=True)
    file.write_text(str(content),encoding='utf-8')
    rel=file.relative_to(PROJECT_ROOT).as_posix()
    return f'Wrote {rel} ({len(str(content))} characters).'+(f' Backup: {backup}' if backup else '')

def browser_project_check(path: str) -> str:
    file=_project_path(path,must_exist=True)
    rel=file.relative_to(PROJECT_ROOT).as_posix()
    ext=file.suffix.lower()
    if ext in {'.js','.cjs','.mjs'}:
        cmd=['node','--check',str(file)]
    elif ext=='.py':
        import sys
        cmd=[sys.executable,'-m','py_compile',str(file)]
    elif ext=='.json':
        json.loads(file.read_text(encoding='utf-8')); return f'{rel}: valid JSON'
    else:
        raise ValueError('Syntax check supports .js/.cjs/.mjs/.py/.json files.')
    done=subprocess.run(cmd,cwd=PROJECT_ROOT,capture_output=True,text=True,timeout=20)
    return f'{rel}: '+('OK' if done.returncode==0 else f'FAILED\n{done.stderr or done.stdout}')

def _split_project_run_command(command: str) -> list[str]:
    """Split a small, shell-free project command into argv tokens.

    The project runner deliberately does not invoke cmd.exe/PowerShell/sh.  This
    parser therefore rejects shell operators rather than trying to interpret
    them.  Project-relative paths should use forward slashes when quoted.
    """
    import shlex

    raw=str(command or '').strip()
    if not raw:
        raise ValueError('command is required')
    if any(ch in raw for ch in ('\r','\n','\x00')):
        raise ValueError('command must be a single line')
    if any(ch in raw for ch in '&|<>;'):
        raise PermissionError('Shell operators are not allowed. Run one project command at a time.')
    try:
        args=shlex.split(raw,posix=True)
    except ValueError as error:
        raise ValueError(f'Could not parse command: {error}') from error
    if not args:
        raise ValueError('command is required')
    return args

def _project_run_executable(name: str) -> str:
    """Resolve an allow-listed executable without enabling a general shell."""
    import sys

    key=Path(str(name or '')).name.lower()
    if key in {'python','python3','py','python.exe','python3.exe','py.exe'}:
        current=Path(sys.executable)
        if not getattr(sys,'frozen',False) and current.name.lower().startswith('python'):
            return str(current)
        for candidate in ('python.exe','python','py.exe','py','python3.exe','python3'):
            found=shutil.which(candidate)
            if found:
                return found
        raise RuntimeError('Python executable was not found in PATH.')
    if key in {'node','node.exe'}:
        found=shutil.which('node.exe') if os.name=='nt' else None
        found=found or shutil.which('node')
        if not found:
            raise RuntimeError('Node.js executable was not found in PATH.')
        return found
    if key in {'npm','npm.cmd','npm.exe'}:
        found=shutil.which('npm.cmd') if os.name=='nt' else None
        found=found or shutil.which('npm')
        if not found:
            raise RuntimeError('npm executable was not found in PATH.')
        return found
    if key in {'pytest','pytest.exe'}:
        # Resolve through Python so the test runner uses the same environment as
        # the available Python command instead of depending on a pytest.exe shim.
        return _project_run_executable('python')
    raise PermissionError('Only python, pytest, node, and npm project commands are allowed.')

def _validate_project_run_path_argument(token: str, run_dir: Path) -> None:
    """Reject path-looking arguments that point outside the Browser-OS project."""
    raw=str(token or '').strip()
    if not raw or raw.startswith('-'):
        # Flags remain arguments to the allow-listed program; shell=False means
        # they are never interpreted by cmd.exe/PowerShell.
        if '..' in raw or re.search(r'(?i)(?:^|=)(?:[a-z]:[\\/]|/|\\\\)',raw) or raw.startswith(('/', '\\', '//')):
            raise PermissionError('Absolute or parent-traversal paths are forbidden in run arguments.')
        return

    looks_like_path=(
        '/' in raw or '\\' in raw or raw.startswith('.') or
        Path(raw).suffix.lower() in {'.py','.js','.cjs','.mjs','.json','.html','.css','.md'}
    )
    if not looks_like_path:
        return
    win=PureWindowsPath(raw)
    if Path(raw).is_absolute() or win.is_absolute() or win.drive or raw.startswith('//'):
        raise PermissionError('Absolute paths are forbidden in run arguments.')
    candidate=(run_dir / raw.replace('\\','/')).resolve(strict=False)
    root=PROJECT_ROOT.resolve(strict=True)
    try:
        rel=candidate.relative_to(root)
    except ValueError as error:
        raise PermissionError('Run argument path escapes the Browser-OS project root.') from error
    if any(part in PROJECT_AGENT_IGNORED_DIRS for part in rel.parts):
        raise PermissionError('Dependency/cache paths are not available to the project runner.')

def browser_project_run(command: str, cwd: str = '.', timeout_seconds: int = 30) -> str:
    """Run one allow-listed project command and return real stdout/stderr.

    This is intentionally a restricted launcher, not a security sandbox.  It
    never invokes a shell, blocks absolute/escaping paths, caps runtime/output,
    and permits only Python/pytest, Node, or existing npm scripts.
    """
    run_dir=_project_path(cwd,must_exist=True)
    if not run_dir.is_dir():
        raise ValueError('cwd must be a project directory')
    if not _agent_visible_project_path(run_dir):
        raise PermissionError('Dependency/cache directories cannot be used as the run directory.')

    args=_split_project_run_command(command)
    requested=Path(args[0]).name.lower()
    executable=_project_run_executable(requested)
    normalized: list[str]

    for token in args[1:]:
        _validate_project_run_path_argument(token,run_dir)

    if requested in {'pytest','pytest.exe'}:
        normalized=[executable,'-m','pytest',*args[1:]]
    elif requested in {'python','python3','py','python.exe','python3.exe','py.exe'}:
        if len(args)<2:
            raise ValueError('Python run requires a project .py file or "-m pytest" / "-m unittest".')
        if args[1]=='-m':
            if len(args)<3 or args[2] not in {'pytest','unittest'}:
                raise PermissionError('Python -m is limited to pytest and unittest.')
            normalized=[executable,*args[1:]]
        else:
            if args[1].startswith('-'):
                raise PermissionError('Python flags such as -c are not allowed. Run a project file instead.')
            target=(run_dir / args[1].replace('\\','/')).resolve(strict=False)
            try:
                target.relative_to(PROJECT_ROOT.resolve(strict=True))
            except ValueError as error:
                raise PermissionError('Python entry point escapes the Browser-OS project root.') from error
            if target.suffix.lower()!='.py' or not target.is_file():
                raise ValueError('Python entry point must be an existing project-relative .py file.')
            if not _agent_visible_project_path(target):
                raise PermissionError('Dependency/cache files cannot be executed by the project runner.')
            normalized=[executable,str(target),*args[2:]]
    elif requested in {'node','node.exe'}:
        if len(args)<2:
            raise ValueError('Node run requires a project JavaScript file or "node --test".')
        if args[1]=='--test':
            normalized=[executable,*args[1:]]
        else:
            if args[1].startswith('-'):
                raise PermissionError('Node eval/loader flags are not allowed. Run a project file instead.')
            target=(run_dir / args[1].replace('\\','/')).resolve(strict=False)
            try:
                target.relative_to(PROJECT_ROOT.resolve(strict=True))
            except ValueError as error:
                raise PermissionError('Node entry point escapes the Browser-OS project root.') from error
            if target.suffix.lower() not in {'.js','.cjs','.mjs'} or not target.is_file():
                raise ValueError('Node entry point must be an existing project-relative .js/.cjs/.mjs file.')
            if not _agent_visible_project_path(target):
                raise PermissionError('Dependency/cache files cannot be executed by the project runner.')
            normalized=[executable,str(target),*args[2:]]
    elif requested in {'npm','npm.cmd','npm.exe'}:
        if len(args)<2:
            raise ValueError('npm run requires "npm test" or "npm run <script>".')
        package_json=run_dir/'package.json'
        if not package_json.is_file():
            raise ValueError('npm commands require package.json in cwd.')
        try:
            package_data=json.loads(package_json.read_text(encoding='utf-8'))
        except Exception as error:
            raise ValueError(f'Could not read package.json: {error}') from error
        scripts=package_data.get('scripts') if isinstance(package_data,dict) else {}
        scripts=scripts if isinstance(scripts,dict) else {}
        if args[1]=='test':
            if 'test' not in scripts:
                raise ValueError('package.json has no test script.')
            normalized=[executable,'test',*args[2:]]
        elif args[1]=='run' and len(args)>=3:
            script=args[2]
            if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,80}',script):
                raise ValueError('Invalid npm script name.')
            if script not in scripts:
                available=', '.join(sorted(str(k) for k in scripts)[:30]) or 'none'
                raise ValueError(f'Unknown npm script {script}. Available scripts: {available}.')
            normalized=[executable,'run',script,*args[3:]]
        else:
            raise PermissionError('npm is limited to existing "test" and "run <script>" commands. Use browser_project_npm for dependency changes.')
    else:
        raise PermissionError('Unsupported project command.')

    timeout=max(1,min(int(timeout_seconds or 30),60))
    env=os.environ.copy()
    env['PYTHONUNBUFFERED']='1'
    env['NO_COLOR']='1'
    env['CI']='1'
    try:
        done=subprocess.run(normalized,cwd=run_dir,capture_output=True,text=True,timeout=timeout,shell=False,env=env)
        stdout=(done.stdout or '')[-8000:]
        stderr=(done.stderr or '')[-8000:]
        status='OK' if done.returncode==0 else 'FAILED'
        return (
            f'COMMAND: {command}\nCWD: {run_dir.relative_to(PROJECT_ROOT).as_posix() or "."}\n'
            f'STATUS: {status}\nEXIT CODE: {done.returncode}\n'
            f'STDOUT:\n{stdout or "[none]"}\nSTDERR:\n{stderr or "[none]"}'
        )
    except subprocess.TimeoutExpired as error:
        stdout=error.stdout.decode('utf-8','replace') if isinstance(error.stdout,bytes) else str(error.stdout or '')
        stderr=error.stderr.decode('utf-8','replace') if isinstance(error.stderr,bytes) else str(error.stderr or '')
        return (
            f'COMMAND: {command}\nCWD: {run_dir.relative_to(PROJECT_ROOT).as_posix() or "."}\n'
            f'STATUS: TIMEOUT\nEXIT CODE: [none]\n'
            f'ERROR: Process exceeded {timeout} seconds and was stopped.\n'
            f'STDOUT:\n{stdout[-8000:] or "[none]"}\nSTDERR:\n{stderr[-8000:] or "[none]"}'
        )

def browser_project_npm(package: str, action: str = 'install') -> str:
    package=str(package or '').strip()
    if not re.fullmatch(r'(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+(?:@[a-zA-Z0-9_.^~<>=*+-]+)?',package):
        raise ValueError('Invalid npm package name.')
    action=str(action or 'install').lower()
    if action not in {'install','uninstall'}:
        raise ValueError('action must be install or uninstall')

    # npm is normally exposed as npm.cmd on Windows. Resolve the executable
    # explicitly so subprocess does not fail merely because the shell is absent.
    npm_exe = shutil.which('npm.cmd') if os.name == 'nt' else None
    npm_exe = npm_exe or shutil.which('npm')
    if not npm_exe:
        raise RuntimeError('npm executable was not found in PATH.')

    try:
        done=subprocess.run([npm_exe,action,package],cwd=PROJECT_ROOT,capture_output=True,text=True,timeout=180)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f'npm {action} {package} timed out after 180 seconds.') from error
    output=(done.stdout+'\n'+done.stderr).strip()[-7000:]
    if done.returncode != 0:
        raise RuntimeError(f'npm {action} {package} failed with exit code {done.returncode}.\n{output or "[no npm output]"}')
    return f'npm {action} {package}: OK\n{output or "[no npm output]"}'

def browser_launch_app(name: str) -> str:
    payload = _request('/api/apps')
    apps = payload.get('apps', []) if isinstance(payload, dict) else payload
    if not isinstance(apps, list):
        apps = []
    wanted = str(name or '').strip().lower()
    match = next((item for item in apps if isinstance(item, dict) and str(item.get('id', '')).lower() == wanted), None)
    if match is None:
        match = next((item for item in apps if isinstance(item, dict) and str(item.get('name', '')).lower() == wanted), None)
    if match is None:
        # Conservative fallback: unique substring match, useful for names such as
        # "Steam" vs "Steam Client" without pretending to do semantic search.
        partial = [item for item in apps if isinstance(item, dict) and wanted and wanted in str(item.get('name', '')).lower()]
        if len(partial) == 1:
            match = partial[0]
    if match is None:
        available = ', '.join(str(item.get('name') or item.get('id')) for item in apps[:40] if isinstance(item, dict))
        return f'Unknown application: {name}. Available applications: {available or "none"}.'
    result = _request('/api/apps/launch', method='POST', body={
        'source': str(match.get('source') or 'windows'),
        'id': str(match.get('id') or ''),
    })
    if not isinstance(result, dict) or not result.get('ok'):
        raise RuntimeError((result or {}).get('error') if isinstance(result, dict) else 'Application launch failed')
    return f"Launched {result.get('name') or match.get('name') or match.get('id')}."


_PRIMITIVE_HANDLERS: dict[str, Callable[..., Any]] = {
    'browser_window': browser_window,
    'browser_system_info': browser_system_info,
    'browser_calendar': browser_calendar,
    'browser_note': browser_note,
    'browser_todo': browser_todo,
    'browser_timer': browser_timer,
    'browser_research': browser_research,
    'browser_read_url': browser_read_url,
    'browser_project_list': browser_project_list,
    'browser_project_read': browser_project_read,
    'browser_project_find': browser_project_find,
    'browser_project_replace': browser_project_replace,
    'browser_project_write': browser_project_write,
    'browser_project_check': browser_project_check,
    'browser_project_run': browser_project_run,
    'browser_project_npm': browser_project_npm,
    'browser_launch_app': browser_launch_app,
}

OS_TOOL_FUNCTIONS: dict[str, Callable[..., Any]] = {}
OS_TOOL_SCHEMAS: list[dict[str, Any]] = []
_GENERATED_DEFINITIONS: dict[str, dict[str, Any]] = {}


def _safe_load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError(f'{path.name}: tool definition must be a YAML mapping')
    return data


def _normalize_parameters(value: Any) -> dict[str, Any]:
    if value is None:
        return {'type': 'object', 'properties': {}}
    if not isinstance(value, dict):
        raise ValueError('parameters must be a mapping')
    if value.get('type') == 'object' or 'properties' in value:
        out = copy.deepcopy(value)
        out.setdefault('type', 'object')
        out.setdefault('properties', {})
        return out

    # Friendly YAML shorthand:
    # parameters:
    #   city: {type: string, required: true}
    properties: dict[str, Any] = {}
    required: list[str] = []
    for key, spec in value.items():
        if not isinstance(spec, dict):
            spec = {'type': str(spec)}
        spec = copy.deepcopy(spec)
        if spec.pop('required', False):
            required.append(str(key))
        properties[str(key)] = spec
    result: dict[str, Any] = {'type': 'object', 'properties': properties}
    if required:
        result['required'] = required
    return result


def _schema_from_definition(definition: dict[str, Any]) -> dict[str, Any]:
    return {
        'name': definition['name'],
        'description': str(definition.get('description') or '').strip(),
        'parameters': _normalize_parameters(definition.get('parameters')),
    }


def _validate_args(schema: dict[str, Any], arguments: dict[str, Any]) -> None:
    params = _normalize_parameters(schema.get('parameters'))
    props = params.get('properties') or {}
    required = params.get('required') or []
    for name in required:
        if name not in arguments:
            raise ValueError(f'Missing required argument: {name}')
    for name, value in arguments.items():
        spec = props.get(name)
        if spec is None:
            raise ValueError(f'Unknown argument: {name}')
        expected = spec.get('type') if isinstance(spec, dict) else None
        if expected == 'string' and not isinstance(value, str):
            raise ValueError(f'{name} must be a string')
        if expected == 'integer' and (not isinstance(value, int) or isinstance(value, bool)):
            raise ValueError(f'{name} must be an integer')
        if expected == 'number' and not isinstance(value, (int, float)):
            raise ValueError(f'{name} must be a number')
        if expected == 'boolean' and not isinstance(value, bool):
            raise ValueError(f'{name} must be a boolean')
        enum = spec.get('enum') if isinstance(spec, dict) else None
        if enum is not None and value not in enum:
            raise ValueError(f'{name} must be one of: {", ".join(map(str, enum))}')


def _resolve_template_string(text: str, arguments: dict[str, Any], results: list[str]) -> Any:
    exact_arg = re.fullmatch(r'\{\{\s*(?:args|arguments)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}', text)
    if exact_arg:
        return arguments.get(exact_arg.group(1), '')
    exact_result = re.fullmatch(r'\{\{\s*steps\.(\d+)\.result\s*\}\}', text)
    if exact_result:
        idx = int(exact_result.group(1))
        return results[idx] if 0 <= idx < len(results) else ''

    def replace(match: re.Match[str]) -> str:
        expr = match.group(1).strip()
        if expr.startswith('args.') or expr.startswith('arguments.'):
            key = expr.split('.', 1)[1]
            return str(arguments.get(key, ''))
        found = re.fullmatch(r'steps\.(\d+)\.result', expr)
        if found:
            idx = int(found.group(1))
            return str(results[idx]) if 0 <= idx < len(results) else ''
        return match.group(0)

    return re.sub(r'\{\{\s*([^{}]+?)\s*\}\}', replace, text)


def _resolve_templates(value: Any, arguments: dict[str, Any], results: list[str]) -> Any:
    if isinstance(value, str):
        return _resolve_template_string(value, arguments, results)
    if isinstance(value, list):
        return [_resolve_templates(item, arguments, results) for item in value]
    if isinstance(value, dict):
        return {key: _resolve_templates(item, arguments, results) for key, item in value.items()}
    return value


def _execute_workflow(name: str, arguments: dict[str, Any], stack: tuple[str, ...] = ()) -> str:
    if name in stack:
        raise RuntimeError('Workflow cycle detected: ' + ' -> '.join((*stack, name)))
    definition = _GENERATED_DEFINITIONS.get(name)
    if definition is None:
        raise RuntimeError(f'Generated tool is not loaded: {name}')
    _validate_args(_schema_from_definition(definition), arguments)

    results: list[str] = []
    trace_lines: list[str] = []
    for index, step in enumerate(definition.get('steps') or []):
        tool_name = str(step.get('tool') or '').strip()
        if not tool_name or tool_name == 'create_tool':
            raise RuntimeError(f'{name}: step {index + 1} uses an invalid tool')
        if tool_name == name:
            raise RuntimeError(f'{name}: a workflow cannot call itself')
        step_args = _resolve_templates(step.get('arguments') or {}, arguments, results)
        if not isinstance(step_args, dict):
            raise RuntimeError(f'{name}: step {index + 1} arguments must resolve to a mapping')

        if tool_name in _GENERATED_DEFINITIONS:
            result = _execute_workflow(tool_name, step_args, (*stack, name))
        else:
            fn = OS_TOOL_FUNCTIONS.get(tool_name)
            if fn is None or tool_name == 'create_tool':
                raise RuntimeError(f'{name}: step {index + 1} references unknown tool: {tool_name}')
            result = fn(**step_args)
        results.append(str(result))
        compact = str(result).replace('\n', ' ')[:240]
        trace_lines.append(f'Step {index + 1}: {tool_name} -> {compact}')

    if not results:
        return f'Workflow {name} completed (no steps).'
    return f'Workflow {name} completed.\n' + '\n'.join(trace_lines)


def _workflow_callable(name: str) -> Callable[..., str]:
    def run_workflow(**kwargs: Any) -> str:
        return _execute_workflow(name, kwargs)
    run_workflow.__name__ = name
    run_workflow.__doc__ = f'Generated YAML workflow: {name}'
    return run_workflow


def _validate_workflow_definition(definition: dict[str, Any]) -> dict[str, Any]:
    allowed_top = {'name', 'type', 'description', 'parameters', 'steps'}
    unknown = set(definition) - allowed_top
    if unknown:
        raise ValueError('Unsupported fields: ' + ', '.join(sorted(unknown)))

    name = str(definition.get('name') or '').strip()
    if not _NAME_RE.fullmatch(name):
        raise ValueError('name must match [a-z][a-z0-9_]{1,63}')
    if name in _PRIMITIVE_HANDLERS or name == 'create_tool':
        raise ValueError(f'{name} is a built-in tool name and cannot be replaced')
    if str(definition.get('type') or 'workflow').strip().lower() != 'workflow':
        raise ValueError('Generated tools must use type: workflow')

    description = str(definition.get('description') or '').strip()
    if not description:
        raise ValueError('description is required')
    parameters = _normalize_parameters(definition.get('parameters'))
    steps = definition.get('steps')
    if not isinstance(steps, list) or not steps:
        raise ValueError('steps must be a non-empty list')
    if len(steps) > 12:
        raise ValueError('A generated workflow may contain at most 12 steps')

    normalized_steps: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f'step {index + 1} must be a mapping')
        tool_name = str(step.get('tool') or '').strip()
        if not tool_name:
            raise ValueError(f'step {index + 1} requires tool')
        if tool_name == 'create_tool' or tool_name == name:
            raise ValueError(f'step {index + 1} cannot call {tool_name}')
        if tool_name not in OS_TOOL_FUNCTIONS and tool_name not in _GENERATED_DEFINITIONS:
            available = ', '.join(sorted(k for k in OS_TOOL_FUNCTIONS if k != 'create_tool'))
            raise ValueError(f'step {index + 1} references unknown tool {tool_name}. Available: {available}')
        step_args = step.get('arguments') or {}
        if not isinstance(step_args, dict):
            raise ValueError(f'step {index + 1} arguments must be a mapping')
        normalized_steps.append({'tool': tool_name, 'arguments': copy.deepcopy(step_args)})

    return {
        'name': name,
        'type': 'workflow',
        'description': description,
        'parameters': parameters,
        'steps': normalized_steps,
    }


def _install_generated(definition: dict[str, Any], *, persist: bool) -> None:
    name = definition['name']
    _GENERATED_DEFINITIONS[name] = definition
    OS_TOOL_FUNCTIONS[name] = _workflow_callable(name)
    schema = _schema_from_definition(definition)
    existing = next((i for i, item in enumerate(OS_TOOL_SCHEMAS) if item.get('name') == name), None)
    if existing is None:
        OS_TOOL_SCHEMAS.append(schema)
    else:
        OS_TOOL_SCHEMAS[existing] = schema
    if persist:
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
        path = GENERATED_DIR / f'{name}.yaml'
        path.write_text(yaml.safe_dump(definition, sort_keys=False, allow_unicode=True), encoding='utf-8')


def create_tool(definition: str) -> str:
    """Create/update a YAML workflow tool and hot-plug it immediately."""
    if not isinstance(definition, str) or not definition.strip():
        raise ValueError('definition must contain YAML')
    try:
        data = yaml.safe_load(definition)
    except yaml.YAMLError as error:
        raise ValueError(f'Invalid YAML: {error}') from error
    if not isinstance(data, dict):
        raise ValueError('Tool definition must be one YAML mapping')

    with _TOOL_LOCK:
        normalized = _validate_workflow_definition(data)
        existed = normalized['name'] in _GENERATED_DEFINITIONS
        _install_generated(normalized, persist=True)
    action = 'Updated' if existed else 'Created'
    return f"{action} and hot-plugged YAML tool: {normalized['name']}"


def _load_base_definitions() -> None:
    DEFINITION_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(DEFINITION_DIR.glob('*.yaml')):
        definition = _safe_load_yaml(path)
        name = str(definition.get('name') or '').strip()
        if not name:
            raise ValueError(f'{path.name}: missing name')
        handler_name = str(definition.get('handler') or name).strip()
        handler = _PRIMITIVE_HANDLERS.get(handler_name)
        if handler is None:
            raise ValueError(f'{path.name}: unknown primitive handler {handler_name}')
        OS_TOOL_FUNCTIONS[name] = handler
        OS_TOOL_SCHEMAS.append(_schema_from_definition(definition))


def _load_generated_definitions() -> None:
    GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    pending: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(GENERATED_DIR.glob('*.yaml')):
        try:
            pending.append((path, _safe_load_yaml(path)))
        except Exception as error:
            print(f'[Browser-OS tools] Skipping unreadable generated tool {path.name}: {error}')

    # Retry a few passes so generated workflows may depend on other generated
    # workflows regardless of filename order.
    for _pass in range(max(1, len(pending) + 1)):
        if not pending:
            break
        remaining: list[tuple[Path, dict[str, Any]]] = []
        progress = False
        for path, raw in pending:
            try:
                normalized = _validate_workflow_definition(raw)
                _install_generated(normalized, persist=False)
                progress = True
            except ValueError as error:
                if 'references unknown tool' in str(error):
                    remaining.append((path, raw))
                else:
                    print(f'[Browser-OS tools] Skipping invalid generated tool {path.name}: {error}')
            except Exception as error:
                print(f'[Browser-OS tools] Skipping invalid generated tool {path.name}: {error}')
        pending = remaining
        if not progress:
            break

    for path, _raw in pending:
        print(f'[Browser-OS tools] Skipping unresolved generated tool {path.name}: dependency unavailable')


_PRIMITIVE_HANDLERS['create_tool'] = create_tool
_load_base_definitions()
_load_generated_definitions()
