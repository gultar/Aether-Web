from __future__ import annotations

import json
import os
import re
import shutil
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
LEGACY_PROFILE = ROOT / "outlook_profile"


def _browseros_data_root() -> Path:
    """Return a stable per-user data directory outside the replaceable app tree."""
    local_app_data = str(os.environ.get("LOCALAPPDATA") or "").strip()
    if local_app_data:
        return Path(local_app_data) / "BrowserOS"
    # Non-Windows/test fallback. BrowserOS is Windows-first, but keeping this
    # deterministic makes development and packaging checks portable.
    return Path.home() / ".browseros"


APP_DATA_ROOT = _browseros_data_root()
PROFILE = APP_DATA_ROOT / "outlook_profile"
SESSION_META = PROFILE / "browser_os_session.json"
PROFILE_MIGRATION_META = APP_DATA_ROOT / "outlook_profile_migration.json"


_PROFILE_SKIP_NAMES = {
    "SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"
}


def _profile_has_data(path: Path) -> bool:
    if not path.exists() or not path.is_dir():
        return False
    try:
        return any(child.name not in _PROFILE_SKIP_NAMES for child in path.iterdir())
    except OSError:
        return False


def _copy_legacy_profile_once() -> None:
    """Copy an old project-local Chromium profile to stable app data once.

    The source is deliberately never removed. This means a failed migration or
    a rollback cannot destroy the user's last known Outlook session.
    """
    if _profile_has_data(PROFILE) or not _profile_has_data(LEGACY_PROFILE):
        return

    APP_DATA_ROOT.mkdir(parents=True, exist_ok=True)
    temp = APP_DATA_ROOT / f"outlook_profile.migrating-{os.getpid()}"
    try:
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)

        def _ignore(_src, names):
            return [name for name in names if name in _PROFILE_SKIP_NAMES]

        shutil.copytree(LEGACY_PROFILE, temp, ignore=_ignore)
        # Another process may have created the persistent profile while copying.
        # Never replace an already populated destination.
        if _profile_has_data(PROFILE):
            shutil.rmtree(temp, ignore_errors=True)
            return
        if PROFILE.exists():
            shutil.rmtree(PROFILE, ignore_errors=True)
        temp.replace(PROFILE)
        PROFILE_MIGRATION_META.write_text(
            json.dumps({
                "migratedAt": time.time(),
                "from": str(LEGACY_PROFILE),
                "to": str(PROFILE),
                "sourcePreserved": True,
            }, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        shutil.rmtree(temp, ignore_errors=True)
        # Migration failure must not prevent Outlook from opening. The new
        # persistent profile will simply start empty and the legacy copy stays put.
        try:
            APP_DATA_ROOT.mkdir(parents=True, exist_ok=True)
            PROFILE_MIGRATION_META.write_text(
                json.dumps({
                    "migratedAt": time.time(),
                    "from": str(LEGACY_PROFILE),
                    "to": str(PROFILE),
                    "sourcePreserved": True,
                    "error": str(exc),
                }, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
DEFAULT_CALENDAR_URL = "https://outlook.live.com/calendar/0/view/agenda"
DEFAULT_COMPOSE_URL = "https://outlook.live.com/calendar/0/deeplink/compose"
OUTLOOK_HOSTS = ("outlook.live.com", "outlook.office.com", "outlook.office365.com")


def _signed_out(url: str) -> bool:
    value = (url or "").lower()
    return "login" in value or "signin" in value or "oauth" in value


def _outlook_host(url: str) -> bool:
    value = (url or "").lower()
    return any(host in value for host in OUTLOOK_HOSTS)


AUTH_FLOW_HOST_HINTS = (
    "login.microsoftonline.com", "login.live.com", "account.live.com",
    "account.microsoft.com", "login.windows.net",
)


def _auth_flow_page(page) -> bool:
    """Return True while Microsoft is visibly handling credentials/MFA/account flow."""
    try:
        host = (urlsplit(str(page.url or "")).netloc or "").lower()
    except Exception:
        host = ""
    if any(token in host for token in AUTH_FLOW_HOST_HINTS):
        return True
    return _explicitly_signed_out(page)


def _explicitly_signed_out(page) -> bool:
    """Detect real authentication UI, not merely an unfamiliar Outlook shell."""
    if _signed_out(page.url):
        return True
    try:
        # Microsoft may localize the button, so also look for login form controls.
        selectors = [
            'input[type="email"]', 'input[name="loginfmt"]', 'input[type="password"]',
            'a[href*="login.microsoftonline.com"]', 'form[action*="login"]'
        ]
        for selector in selectors:
            loc = page.locator(selector)
            if loc.count() and loc.first.is_visible(timeout=150):
                return True
        sign_in = page.get_by_role("button", name=re.compile(r"^sign in$|^se connecter$|^connexion$", re.I))
        if sign_in.count() and sign_in.first.is_visible(timeout=150):
            return True
    except Exception:
        pass
    return False


def _authenticated_calendar_shell(page) -> bool:
    """Recognize an authenticated Outlook shell without depending on one UI version."""
    if not _outlook_host(page.url) or _explicitly_signed_out(page):
        return False

    # Strong calendar-specific signals first.
    checks = [
        lambda: page.get_by_role("button", name=re.compile(r"new (event|appointment)", re.I)),
        lambda: page.locator('[aria-label*="New event" i], [aria-label*="New appointment" i]'),
        lambda: page.locator('[aria-label*="Calendar" i][role="button"], [aria-label*="Calendar" i][role="treeitem"]'),
        # Outlook changes its calendar markup frequently.  These generic app-shell
        # signals are intentionally broader but are only accepted on an Outlook host
        # after explicit sign-out UI has been ruled out.
        lambda: page.locator('[role="main"]'),
        lambda: page.locator('[data-app-section="Navigation"]'),
        lambda: page.locator('button[aria-label*="Settings" i], button[aria-label*="Help" i], button[aria-label*="Search" i]'),
    ]
    for make_locator in checks:
        try:
            loc = make_locator()
            if loc.count() and loc.first.is_visible(timeout=250):
                return True
        except Exception:
            pass

    # Final conservative fallback: an Outlook-hosted page with a substantial loaded
    # app body and no login controls is authenticated enough to attempt calendar
    # extraction.  Extraction itself remains the source of truth.
    try:
        body_text = page.locator('body').inner_text(timeout=500)
        if len((body_text or '').strip()) > 200:
            return True
    except Exception:
        pass
    return False




def _load_session_meta() -> dict:
    try:
        return json.loads(SESSION_META.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_session_meta(page) -> None:
    try:
        PROFILE.mkdir(parents=True, exist_ok=True)
        url = str(page.url or "")
        if _outlook_host(url):
            SESSION_META.write_text(json.dumps({"calendarUrl": url, "savedAt": time.time()}), encoding="utf-8")
    except Exception:
        pass


def _calendar_url() -> str:
    url = str(_load_session_meta().get("calendarUrl") or "").strip()
    return url if _outlook_host(url) else DEFAULT_CALENDAR_URL


def _compose_base_url() -> str:
    url = _calendar_url().lower()
    if "outlook.office.com" in url or "outlook.office365.com" in url:
        host = "https://outlook.office.com"
        return host + "/calendar/deeplink/compose"
    return DEFAULT_COMPOSE_URL


def _requested_day(payload: dict | None):
    payload = payload or {}
    for key in ("start", "end", "date"):
        value = str(payload.get(key) or "").strip()
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", value)
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y-%m-%d").date()
            except ValueError:
                pass
    return None


def _navigate_calendar_to_day(page, day) -> bool:
    """Best-effort select a requested calendar day in current Outlook Web UI."""
    if day is None:
        return True
    iso = day.isoformat()
    # First give current Outlook builds a date hint in the URL. Unknown params are
    # harmless; some builds honor it and navigate immediately.
    try:
        parts = urlsplit(_calendar_url())
        q = dict(parse_qsl(parts.query, keep_blank_values=True))
        q["date"] = iso
        hinted = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q), parts.fragment))
        page.goto(hinted, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2200)
    except Exception:
        pass

    months_en=["January","February","March","April","May","June","July","August","September","October","November","December"]
    months_fr=["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"]
    labels = [
        f"{months_en[day.month-1]} {day.day}, {day.year}",
        f"{day.day} {months_en[day.month-1]} {day.year}",
        f"{day.day} {months_fr[day.month-1]} {day.year}",
        iso,
    ]
    # Outlook's mini-calendar usually exposes each day as an aria-label on a button/gridcell.
    for label in labels:
        rx = re.compile(re.escape(label), re.I)
        locators = [
            page.get_by_role("button", name=rx),
            page.get_by_role("gridcell", name=rx),
            page.locator(f'[aria-label*="{label}" i]'),
            page.locator(f'[title*="{label}" i]'),
        ]
        for loc in locators:
            try:
                if loc.count() and loc.first.is_visible(timeout=250):
                    loc.first.click(timeout=4000)
                    page.wait_for_timeout(1800)
                    return True
            except Exception:
                pass
    return False


def _launch_context(playwright, *, headless: bool):
    _copy_legacy_profile_once()
    PROFILE.mkdir(parents=True, exist_ok=True)
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        headless=headless,
        args=[
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
        ],
    )


def _auth_state(page) -> str:
    if _explicitly_signed_out(page):
        return "signed_out"
    if _authenticated_calendar_shell(page):
        return "connected"
    # Unknown is deliberately distinct from signed_out.  Outlook UI changes should
    # not erase a valid persisted session merely because our selectors are stale.
    return "unknown"


def status() -> dict:
    with sync_playwright() as p:
        context = _launch_context(p, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=20000)
            deadline = time.time() + 8
            state = "unknown"
            while time.time() < deadline:
                state = _auth_state(page)
                if state in ("connected", "signed_out"):
                    break
                page.wait_for_timeout(500)
            if state == "connected":
                _save_session_meta(page)
                return {"ok": True, "connected": True, "state": "connected", "url": page.url}
            if state == "signed_out":
                return {"ok": True, "connected": False, "state": "signed_out", "signedOut": True, "url": page.url}
            return {"ok": True, "connected": False, "state": "unknown", "url": page.url}
        finally:
            context.close()

def login() -> dict:
    with sync_playwright() as p:
        context = _launch_context(p, headless=False)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=30000)
            started = time.time()
            deadline = started + 300
            ready_since = None
            last_calendar_probe = 0.0
            while time.time() < deadline:
                if _authenticated_calendar_shell(page):
                    ready_since = ready_since or time.time()
                    # Require a short stable authenticated period so redirects or
                    # intermediate shells cannot prematurely close the login window.
                    if time.time() - ready_since >= 2.0:
                        _save_session_meta(page)
                        return {"ok": True, "message": "Outlook session is ready.", "url": page.url}
                else:
                    ready_since = None
                    # Microsoft sometimes finishes authentication on a generic Microsoft
                    # landing page instead of returning to the original Outlook deep link.
                    # Once credential/MFA UI has disappeared, periodically return to the
                    # calendar and let the persisted session prove that login succeeded.
                    now = time.time()
                    if (now - started >= 6.0 and not _auth_flow_page(page) and
                            not _outlook_host(page.url) and now - last_calendar_probe >= 5.0):
                        last_calendar_probe = now
                        try:
                            page.goto(DEFAULT_CALENDAR_URL, wait_until="domcontentloaded", timeout=30000)
                            page.wait_for_timeout(1200)
                        except Exception:
                            pass
                page.wait_for_timeout(500)
            return {"ok": False, "error": "Outlook sign-in timed out."}
        finally:
            context.close()


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def _parse_date(text: str):
    text = _clean(text)
    candidates = []
    patterns = [
        r"\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b",
        r"\b([A-Z][a-z]+\s+\d{1,2},\s+\d{4})\b",
        r"\b(\d{1,2}/\d{1,2}/\d{4})\b",
        r"\b(\d{4}-\d{1,2}-\d{1,2})\b",
    ]
    for pat in patterns:
        candidates.extend(re.findall(pat, text))
    for value in candidates:
        for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                pass
    return None


def _parse_times(text: str):
    values = re.findall(r"\b(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\b", text)
    out = []
    for value in values[:2]:
        v = re.sub(r"\s+", " ", value.strip()).upper()
        for fmt in ("%I:%M %p", "%H:%M"):
            try:
                out.append(datetime.strptime(v, fmt).time())
                break
            except ValueError:
                pass
    return out


def _iso(dt):
    return dt.isoformat(timespec="seconds") if dt else None


def _normalize_candidate(row: dict):
    aria = _clean(row.get("aria") or "")
    text = _clean(row.get("text") or "")
    title = _clean(row.get("title") or "")
    display = aria or title or text
    if not display or len(display) < 3:
        return None

    lower = display.lower()
    noise = {
        "calendar", "new event", "today", "previous", "next", "settings", "search", "help",
        "month", "week", "work week", "day", "agenda", "year"
    }
    if lower in noise:
        return None

    attrs = row.get("attrs") or {}
    joined = " | ".join([aria, title, text] + [str(v) for v in attrs.values() if v])
    eventish = any("itemid" in k.lower() or "calitem" in k.lower() for k in attrs)
    eventish = eventish or row.get("eventish", False)
    eventish = eventish or bool(_parse_date(joined) and (_parse_times(joined) or "all day" in joined.lower()))
    if not eventish:
        return None

    date = _parse_date(joined)
    times = _parse_times(joined)
    all_day = "all day" in joined.lower()
    start = end = None
    if date:
        if all_day:
            start = datetime.combine(date, datetime.min.time())
            end = start + timedelta(days=1)
        elif times:
            start = datetime.combine(date, times[0])
            end = datetime.combine(date, times[1] if len(times) > 1 else times[0])
            if end < start:
                end += timedelta(days=1)

    # Outlook accessibility labels usually begin with the subject. Prefer explicit text/title.
    subject = text.split("\n", 1)[0].strip() if text else ""
    if not subject or len(subject) > 180:
        subject = title or re.split(r",\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}:\d{2}|All day)", display, maxsplit=1, flags=re.I)[0]
    subject = _clean(subject).strip(" ,-") or "Event"
    if subject.lower() in noise:
        return None

    return {
        "subject": subject[:240],
        "display": display[:1000],
        "start": _iso(start),
        "end": _iso(end),
        "location": "",
        "allDay": all_day,
    }


def _parse_outlook_datetime(value):
    """Best-effort conversion of Outlook/OWA date values to local-naive ISO strings."""
    if value is None:
        return None
    if isinstance(value, dict):
        for key in ("DateTime", "dateTime", "Value", "value", "Start", "End"):
            if key in value:
                parsed = _parse_outlook_datetime(value.get(key))
                if parsed:
                    return parsed
        return None
    text = _clean(str(value))
    if not text:
        return None
    m = re.search(r"/Date\((\d+)(?:[+-]\d+)?\)/", text)
    if m:
        try:
            return datetime.fromtimestamp(int(m.group(1)) / 1000).isoformat(timespec="seconds")
        except Exception:
            pass
    normalized = text.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt.isoformat(timespec="seconds")
    except Exception:
        return None


def _location_text(value):
    if not value:
        return ""
    if isinstance(value, str):
        return _clean(value)
    if isinstance(value, dict):
        for key in ("DisplayName", "displayName", "Name", "name", "Location", "location"):
            if value.get(key):
                return _clean(str(value.get(key)))
    return ""


def _event_from_mapping(obj: dict):
    """Recognize calendar-item dictionaries from multiple Outlook Web response shapes."""
    if not isinstance(obj, dict):
        return None
    subject = None
    for key in ("Subject", "subject", "Title", "title", "Name", "name"):
        value = obj.get(key)
        if isinstance(value, str) and _clean(value):
            subject = _clean(value)
            break
    if not subject:
        return None

    start_value = end_value = None
    for key in ("Start", "start", "StartTime", "startTime", "StartDateTime", "startDateTime"):
        if key in obj:
            start_value = obj.get(key)
            break
    for key in ("End", "end", "EndTime", "endTime", "EndDateTime", "endDateTime"):
        if key in obj:
            end_value = obj.get(key)
            break
    start = _parse_outlook_datetime(start_value)
    end = _parse_outlook_datetime(end_value)
    if not start:
        return None

    all_day = bool(obj.get("IsAllDay", obj.get("isAllDay", obj.get("AllDay", obj.get("allDay", False)))))
    location = ""
    for key in ("Location", "location", "Locations", "locations"):
        if key in obj:
            value = obj.get(key)
            if isinstance(value, list):
                location = ", ".join(filter(None, (_location_text(v) for v in value)))
            else:
                location = _location_text(value)
            if location:
                break
    event_id = ""
    for key in ("ItemId", "itemId", "Id", "id", "CalendarItemId", "calendarItemId"):
        value = obj.get(key)
        if isinstance(value, dict):
            value = value.get("Id") or value.get("id")
        if value:
            event_id = str(value)
            break
    web_link = ""
    for key in ("WebLink", "webLink", "ItemUrl", "itemUrl", "Url", "url"):
        value = obj.get(key)
        if isinstance(value, str) and value.startswith("http"):
            web_link = value
            break
    return {
        "subject": subject[:240],
        "display": subject[:1000],
        "start": start,
        "end": end or start,
        "location": location[:300],
        "allDay": all_day,
        "id": event_id[:500],
        "webLink": web_link[:2000],
        "source": "outlook-network",
    }


def _walk_event_objects(value, out: dict, depth=0):
    if depth > 20:
        return
    if isinstance(value, dict):
        event = _event_from_mapping(value)
        if event:
            key = event.get("id") or (event.get("subject", "").lower(), event.get("start"), event.get("end"))
            out[str(key)] = event
        for child in value.values():
            if isinstance(child, (dict, list)):
                _walk_event_objects(child, out, depth + 1)
    elif isinstance(value, list):
        for child in value:
            if isinstance(child, (dict, list)):
                _walk_event_objects(child, out, depth + 1)



def _first_existing(*locators):
    for locator in locators:
        try:
            if locator.count() > 0:
                return locator.first
        except Exception:
            pass
    return None


def _compose_url(payload: dict) -> str:
    subject = _clean(str(payload.get("subject") or ""))
    start = _parse_outlook_datetime(payload.get("start"))
    end = _parse_outlook_datetime(payload.get("end"))
    if not subject or not start:
        raise ValueError("subject and start are required")
    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end or start)
    if end_dt <= start_dt:
        end_dt = start_dt + timedelta(hours=1)
    params = {
        "path": "/calendar/action/compose",
        "rru": "addevent",
        "allday": "true" if payload.get("allDay") else "false",
        "subject": subject,
        "startdt": start_dt.isoformat(timespec="seconds"),
        "enddt": end_dt.isoformat(timespec="seconds"),
        "location": _clean(str(payload.get("location") or "")),
    }
    return _compose_base_url() + "?" + urlencode(params)


def create_event(payload: dict) -> dict:
    # Start from the authenticated calendar shell rather than a compose deeplink.
    # Microsoft can accept the persisted session on the calendar page yet redirect a
    # direct /deeplink/compose navigation to sign-in (especially across account types).
    with sync_playwright() as p:
        context = _launch_context(p, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3000)
            auth = _auth_state(page)
            if auth == "signed_out":
                return {"ok": False, "signedOut": True, "error": "Outlook session is not signed in."}
            if not _outlook_host(page.url):
                return {"ok": False, "error": f"Outlook calendar navigation ended on an unexpected page: {page.url}"}
            _save_session_meta(page)

            new_event = _first_existing(
                page.get_by_role("button", name=re.compile(r"new (event|appointment)", re.I)),
                page.get_by_role("button", name=re.compile(r"nouvel? (événement|évènement)|nouveau rendez-vous", re.I)),
                page.locator('[aria-label*="New event" i], [aria-label*="New appointment" i]'),
                page.locator('[aria-label*="Nouvel événement" i], [aria-label*="Nouvel évènement" i], [aria-label*="Nouveau rendez-vous" i]'),
                page.get_by_text(re.compile(r"^new event$|^new appointment$|^nouvel? (événement|évènement)$|^nouveau rendez-vous$", re.I)),
            )
            if new_event is None:
                return {"ok": False, "error": "Outlook calendar is signed in, but the New event control could not be found."}
            new_event.click(timeout=5000)
            page.wait_for_timeout(1200)

            if not _fill_event_form(page, payload):
                return {"ok": False, "error": "Outlook event form opened, but its fields could not be identified."}
            save = _first_existing(
                page.get_by_role("button", name="Save", exact=True),
                page.get_by_role("button", name="Enregistrer", exact=True),
                page.get_by_text("Save", exact=True),
                page.get_by_text("Enregistrer", exact=True),
            )
            if save is None:
                return {"ok": False, "error": "Outlook event form opened, but Save could not be found."}
            save.click(timeout=5000)
            page.wait_for_timeout(1800)
            return {"ok": True, "message": "Outlook event created."}
        finally:
            context.close()


def _fill_event_form(page, payload: dict) -> bool:
    subject = _clean(str(payload.get("subject") or ""))
    start = _parse_outlook_datetime(payload.get("start"))
    end = _parse_outlook_datetime(payload.get("end"))
    if not subject or not start:
        raise ValueError("subject and start are required")
    start_dt = datetime.fromisoformat(start)
    end_dt = datetime.fromisoformat(end or start)
    all_day = bool(payload.get("allDay"))
    if end_dt <= start_dt:
        end_dt = start_dt + (timedelta(days=1) if all_day else timedelta(hours=1))
    title = _first_existing(
        page.get_by_placeholder("Add a title"), page.get_by_placeholder("Ajouter un titre"),
        page.locator('input[aria-label="Add a title"]'), page.locator('input[aria-label="Ajouter un titre"]')
    )
    if title is not None:
        title.fill(subject)
    # Outlook labels vary by locale; use explicit labels first.
    fields = {
        "sd": _first_existing(page.locator('input[aria-label="Start date"]'), page.locator('input[aria-label="Date de début"]')),
        "st": _first_existing(page.locator('input[aria-label="Start time"]'), page.locator('input[aria-label="Heure de début"]')),
        "ed": _first_existing(page.locator('input[aria-label="End date"]'), page.locator('input[aria-label="Date de fin"]')),
        "et": _first_existing(page.locator('input[aria-label="End time"]'), page.locator('input[aria-label="Heure de fin"]')),
    }
    values = {"sd": start_dt.strftime("%Y-%m-%d"), "st": start_dt.strftime("%H:%M"), "ed": end_dt.strftime("%Y-%m-%d"), "et": end_dt.strftime("%H:%M")}
    all_day_control = _first_existing(
        page.get_by_role("checkbox", name="All day"), page.get_by_role("checkbox", name="Toute la journée"),
        page.get_by_text("All day", exact=True), page.get_by_text("Toute la journée", exact=True)
    )
    if all_day_control is not None:
        try:
            checked = all_day_control.is_checked()
            if checked != all_day:
                all_day_control.click(); page.wait_for_timeout(250)
        except Exception:
            pass
    for key, field in fields.items():
        if field is not None:
            try:
                field.click(); field.press("Control+A"); field.fill(values[key]); field.press("Tab")
            except Exception:
                pass
    loc = _clean(str(payload.get("location") or ""))
    if loc:
        lf = _first_existing(
            page.get_by_placeholder("Add a location"), page.get_by_placeholder("Ajouter un emplacement"),
            page.get_by_placeholder("Search for a room or location"), page.get_by_placeholder("Rechercher une salle ou un emplacement")
        )
        if lf is not None:
            try: lf.fill(loc)
            except Exception: pass
    return title is not None


def update_event(payload: dict) -> dict:
    event_id = _clean(str(payload.get("id") or ""))
    subject_before = _clean(str(payload.get("originalSubject") or payload.get("subject") or ""))
    web_link = str(payload.get("webLink") or "").strip()
    with sync_playwright() as p:
        context = _launch_context(p, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            page.goto(web_link if web_link.startswith("http") else _calendar_url(), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(3500)
            if _auth_state(page) == "signed_out":
                return {"ok": False, "signedOut": True, "error": "Outlook session is not signed in."}

            # If a direct item link did not already open the item, locate it in Agenda.
            edit = _first_existing(page.get_by_role("button", name="Edit"), page.get_by_role("button", name="Modifier"))
            if edit is not None:
                edit.click(); page.wait_for_timeout(900)
            else:
                candidate = None
                if event_id:
                    candidate = _first_existing(page.locator(f'[data-itemid="{event_id}"]'), page.locator(f'[data-calitemid="{event_id}"]'))
                if candidate is None and subject_before:
                    candidate = _first_existing(page.get_by_text(subject_before, exact=True), page.get_by_text(subject_before))
                if candidate is None:
                    # Search progressively through the virtualized agenda.
                    for _ in range(18):
                        if subject_before:
                            candidate = _first_existing(page.get_by_text(subject_before, exact=True), page.get_by_text(subject_before))
                        if candidate is not None: break
                        page.mouse.wheel(0, 900); page.wait_for_timeout(250)
                if candidate is None:
                    return {"ok": False, "error": "Could not locate this Outlook event for editing."}
                candidate.click(); page.wait_for_timeout(1200)
                edit = _first_existing(
                    page.get_by_role("button", name="Edit"), page.get_by_role("button", name="Modifier"),
                    page.get_by_text("Edit", exact=True), page.get_by_text("Modifier", exact=True)
                )
                if edit is not None:
                    edit.click(); page.wait_for_timeout(900)

            if not _fill_event_form(page, payload):
                return {"ok": False, "error": "Outlook edit form could not be opened."}
            save = _first_existing(
                page.get_by_role("button", name="Save", exact=True), page.get_by_role("button", name="Enregistrer", exact=True),
                page.get_by_text("Save", exact=True), page.get_by_text("Enregistrer", exact=True)
            )
            if save is None:
                return {"ok": False, "error": "Outlook edit form opened, but Save could not be found."}
            save.click(); page.wait_for_timeout(1800)
            return {"ok": True, "message": "Outlook event updated."}
        finally:
            context.close()


def delete_event(payload: dict) -> dict:
    event_id = _clean(str(payload.get("id") or ""))
    subject = _clean(str(payload.get("subject") or ""))
    web_link = str(payload.get("webLink") or "").strip()
    if not event_id and not subject and not web_link:
        raise ValueError("id, subject, or webLink is required")

    def find_candidate(page):
        candidate = None
        if event_id:
            candidate = _first_existing(
                page.locator(f'[data-itemid="{event_id}"]'),
                page.locator(f'[data-calitemid="{event_id}"]')
            )
        if candidate is None and subject:
            candidate = _first_existing(page.get_by_text(subject, exact=True), page.get_by_text(subject))
        return candidate

    def find_delete_action(page):
        return _first_existing(
            page.get_by_role("menuitem", name=re.compile(r"^(delete|supprimer)( event| l.?événement)?$", re.I)),
            page.get_by_role("button", name=re.compile(r"^(delete|supprimer)( event| l.?événement)?$", re.I)),
            page.get_by_text(re.compile(r"^(delete|supprimer)( event| l.?événement)?$", re.I))
        )

    def confirm_delete(page):
        # Confirmation wording differs between personal Outlook, Microsoft 365 and locales.
        confirm = _first_existing(
            page.get_by_role("button", name=re.compile(r"^(delete|supprimer|yes|oui|ok)$", re.I)),
            page.get_by_role("button", name=re.compile(r"delete (event|series)|supprimer (l.?événement|la série)", re.I)),
            page.get_by_text(re.compile(r"^(delete|supprimer|yes|oui|ok)$", re.I))
        )
        if confirm is not None:
            try:
                confirm.click(timeout=3000)
                page.wait_for_timeout(1200)
                return True
            except Exception:
                pass
        return False

    with sync_playwright() as p:
        context = _launch_context(p, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            # Always start from the calendar view. Outlook deeplinks are inconsistent and
            # can open a read-only preview whose Delete control is not the event action.
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(4500)
            if _auth_state(page) == "signed_out":
                return {"ok": False, "signedOut": True, "error": "Outlook session is not signed in."}

            candidate = find_candidate(page)
            if candidate is None:
                # Outlook virtualizes the calendar/agenda, so progressively scroll until found.
                for _ in range(24):
                    page.mouse.wheel(0, 850)
                    page.wait_for_timeout(250)
                    candidate = find_candidate(page)
                    if candidate is not None:
                        break
            if candidate is None:
                return {"ok": False, "error": "Could not locate this Outlook event for deletion."}

            deleted = False

            # 1) Preferred path: Outlook's event context menu. This is much less ambiguous
            # than buttons in the read-only event preview and works across compact/full views.
            try:
                candidate.scroll_into_view_if_needed(timeout=3000)
                candidate.click(button="right", timeout=5000)
                page.wait_for_timeout(500)
                action = find_delete_action(page)
                if action is not None:
                    action.click(timeout=5000)
                    page.wait_for_timeout(700)
                    confirm_delete(page)
                    deleted = True
            except Exception:
                deleted = False

            # 2) Fallback: open the event, enter the full editor, then use its Delete action.
            # Do not use a generic Delete control from the preview because Outlook may expose
            # unrelated hidden/disabled controls there.
            if not deleted:
                try:
                    candidate.click(timeout=5000)
                    page.wait_for_timeout(900)
                    edit = _first_existing(
                        page.get_by_role("button", name=re.compile(r"^(edit|modifier)$", re.I)),
                        page.get_by_text(re.compile(r"^(edit|modifier)$", re.I))
                    )
                    if edit is not None:
                        edit.click(timeout=5000)
                        page.wait_for_timeout(900)

                    action = find_delete_action(page)
                    if action is None:
                        more = _first_existing(
                            page.get_by_role("button", name=re.compile(r"more (actions|options)|other actions|plus d.?actions|autres actions", re.I)),
                            page.locator('button[aria-label*="More" i]'),
                            page.locator('button[title*="More" i]'),
                            page.locator('button[aria-label*="Plus" i]'),
                            page.locator('button[title*="Plus" i]')
                        )
                        if more is not None:
                            more.click(timeout=5000)
                            page.wait_for_timeout(400)
                            action = find_delete_action(page)
                    if action is not None:
                        action.click(timeout=5000)
                        page.wait_for_timeout(700)
                        confirm_delete(page)
                        deleted = True
                except Exception:
                    deleted = False

            # 3) Last UI fallback: focus the actual event element and use Outlook's Delete key.
            if not deleted:
                try:
                    candidate.focus(timeout=3000)
                    page.keyboard.press("Delete")
                    page.wait_for_timeout(700)
                    confirm_delete(page)
                    deleted = True
                except Exception:
                    deleted = False

            if not deleted:
                return {"ok": False, "error": "Outlook event was found, but no delete action could be executed."}

            # Verify against a freshly reloaded calendar in the SAME browser context. This
            # avoids a second Chromium launch while ensuring a stale virtualized DOM cannot
            # create a false success.
            page.wait_for_timeout(1800)
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(4500)
            if _auth_state(page) == "signed_out":
                return {"ok": False, "signedOut": True, "error": "Outlook session became signed out while verifying deletion."}

            remaining = find_candidate(page)
            if remaining is None:
                # A subject-only lookup can miss an off-screen event. For an id-based delete,
                # the absence of the exact item id after a fresh reload is strong verification.
                return {"ok": True, "message": "Outlook event removed and verified."}

            return {"ok": False, "error": "Outlook delete action ran, but the event is still present after a fresh calendar reload."}
        finally:
            context.close()


def events(payload: dict | None = None) -> dict:
    with sync_playwright() as p:
        context = _launch_context(p, headless=True)
        try:
            page = context.pages[0] if context.pages else context.new_page()
            network_events = {}
            response_stats = {"json": 0, "candidate": 0, "errors": 0}
            response_urls = []

            def capture_response(response):
                try:
                    url = response.url or ""
                    ctype = (response.headers.get("content-type") or "").lower()
                    interesting_url = any(token in url.lower() for token in (
                        "calendar", "service.svc", "getcalendar", "finditem", "outlook", "owa"
                    ))
                    if not interesting_url:
                        return
                    if len(response_urls) < 40:
                        response_urls.append(url)
                    if "json" not in ctype and "text" not in ctype:
                        return
                    body = response.body()
                    if not body or len(body) > 8_000_000:
                        return
                    text = body.decode("utf-8", errors="ignore")
                    if not text.lstrip().startswith(("{", "[")):
                        return
                    payload = json.loads(text)
                    response_stats["json"] += 1
                    before = len(network_events)
                    _walk_event_objects(payload, network_events)
                    if len(network_events) > before:
                        response_stats["candidate"] += len(network_events) - before
                except Exception:
                    response_stats["errors"] += 1

            page.on("response", capture_response)
            requested_day = _requested_day(payload)
            page.goto(_calendar_url(), wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2500)
            if requested_day is not None:
                _navigate_calendar_to_day(page, requested_day)
            page.wait_for_timeout(4500)
            auth = _auth_state(page)
            if auth == "signed_out":
                return {"ok": False, "signedOut": True, "error": "Outlook session is not signed in."}
            # Do not fail merely because the current Outlook UI version did not match
            # our shell selectors.  If we are still on an Outlook host and there is no
            # explicit login UI, continue and let the actual event extraction decide.
            if not _outlook_host(page.url):
                return {"ok": False, "error": f"Outlook calendar navigation ended on an unexpected page: {page.url}"}
            _save_session_meta(page)

            for _ in range(10):
                page.mouse.wheel(0, 1100)
                page.wait_for_timeout(500)

            dom_events = {}
            stagnant = 0
            last_count = 0
            for _ in range(24):
                raw = page.evaluate(r'''() => {
                  const sels = [
                    '[data-calitemid]', '[data-itemid]',
                    '[role="button"][aria-label]', '[role="gridcell"] [aria-label]',
                    '[role="listitem"]', '[role="option"]', '[title]'
                  ];
                  const out=[]; const seen=new Set();
                  for(const sel of sels){
                    for(const el of document.querySelectorAll(sel)){
                      const aria=el.getAttribute('aria-label')||'';
                      const title=el.getAttribute('title')||'';
                      const text=(el.innerText||el.textContent||'').trim();
                      const attrs={};
                      for(const a of el.attributes||[]){
                        const n=a.name.toLowerCase();
                        if(n.includes('start')||n.includes('end')||n.includes('time')||n.includes('date')||n.includes('itemid')||n.includes('calitem')) attrs[a.name]=a.value;
                      }
                      const cls=String(el.className||'');
                      const eventish=Object.keys(attrs).some(k=>/itemid|calitem/i.test(k)) || /event|calendaritem|appointment/i.test(cls);
                      const key=aria+'\n'+title+'\n'+text;
                      if(!key.trim()||seen.has(key)) continue; seen.add(key);
                      out.push({aria,title,text,attrs,eventish});
                    }
                  }
                  return out;
                }''')
                for row in raw:
                    item = _normalize_candidate(row)
                    if not item:
                        continue
                    item["source"] = "outlook-dom"
                    key = (item.get("subject", "").lower(), item.get("start") or item.get("display", "").lower())
                    dom_events[str(key)] = item
                if len(dom_events) == last_count:
                    stagnant += 1
                else:
                    stagnant = 0
                    last_count = len(dom_events)
                if stagnant >= 4:
                    break
                moved = page.evaluate(r'''() => {
                  const candidates=[...document.querySelectorAll('[data-is-scrollable="true"], [role="main"], main, .ms-ScrollablePane--contentContainer')];
                  let best=null, room=0;
                  for(const el of candidates){const r=(el.scrollHeight||0)-(el.clientHeight||0); if(r>room){room=r;best=el}}
                  if(best && room>0){const before=best.scrollTop;best.scrollTop=Math.min(best.scrollTop+Math.max(500,best.clientHeight*.85),best.scrollHeight);return best.scrollTop!==before}
                  const before=window.scrollY;window.scrollBy(0,Math.max(600,window.innerHeight*.85));return window.scrollY!==before;
                }''')
                page.wait_for_timeout(300)
                if not moved:
                    break

            merged = dict(dom_events)
            merged.update(network_events)
            items = list(merged.values())
            items.sort(key=lambda e: (e.get("start") is None, e.get("start") or "9999", e.get("subject") or ""))
            return {
                "ok": True,
                "account": "Outlook Web",
                "events": items[:1000],
                "scanned": len(items),
                "networkEvents": len(network_events),
                "domEvents": len(dom_events),
                "networkJsonResponses": response_stats["json"],
                "networkErrors": response_stats["errors"],
                "diagnosticUrls": response_urls[:12],
                "requestedDay": requested_day.isoformat() if requested_day else None,
                "calendarUrl": page.url,
            }
        finally:
            context.close()

def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "events"
    try:
        payload = {}
        if action in ("create", "update", "delete", "events"):
            raw = sys.argv[2] if len(sys.argv) > 2 else "{}"
            payload = json.loads(raw or "{}")
        if action == "login": result = login()
        elif action == "status": result = status()
        elif action == "events": result = events(payload)
        elif action == "create": result = create_event(payload)
        elif action == "update": result = update_event(payload)
        elif action == "delete": result = delete_event(payload)
        else: result = {"ok": False, "error": f"Unknown action: {action}"}
    except Exception as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
