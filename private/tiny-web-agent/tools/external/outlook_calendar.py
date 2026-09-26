from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright


# OUTLOOK_PROFILE = Path("./outlook_profile")
OUTLOOK_PROFILE = Path(__file__).resolve().parents[2] / "outlook_profile"
OUTLOOK_COMPOSE_URL = "https://outlook.live.com/calendar/0/deeplink/compose"


def _first_existing(*locators):
    """Return the first Playwright locator that matches at least one element."""
    for locator in locators:
        try:
            if locator.count() > 0:
                return locator.first
        except Exception:
            pass

    return None


def _build_outlook_event_url(
    subject: str,
    start_date: str,
    start_time: str,
    end_date: str,
    end_time: str,
    location: str = "",
) -> str:
    """
    Build an Outlook.com calendar compose URL with the event fields pre-filled.

    This avoids trying to manipulate Outlook's date/time widgets directly.
    Outlook's web UI changes those controls frequently, while the compose URL
    accepts ISO-like date/time values.
    """

    start_datetime = f"{start_date}T{start_time}:00"
    end_datetime = f"{end_date}T{end_time}:00"

    params = {
        "path": "/calendar/action/compose",
        "rru": "addevent",
        "allday": "false",
        "subject": subject,
        "startdt": start_datetime,
        "enddt": end_datetime,
        "location": location,
    }

    return f"{OUTLOOK_COMPOSE_URL}?{urlencode(params)}"


def create_outlook_event(
    subject: str,
    start_date: str,
    start_time: str,
    end_date: str,
    end_time: str,
    location: str = "",
) -> str:
    """
    Create an event in Outlook.com using Playwright browser automation.

    Expected formats:
        start_date: YYYY-MM-DD
        end_date:   YYYY-MM-DD
        start_time: HH:MM
        end_time:   HH:MM

    The existing Playwright profile in ./outlook_profile is reused so the
    Outlook login session persists between runs.
    """

    event_url = _build_outlook_event_url(
        subject=subject,
        start_date=start_date,
        start_time=start_time,
        end_date=end_date,
        end_time=end_time,
        location=location,
    )

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(OUTLOOK_PROFILE),
            headless=False,
        )

        try:
            page = context.pages[0] if context.pages else context.new_page()

            # Open Outlook directly in the pre-filled event compose view.
            page.goto(
                event_url,
                wait_until="domcontentloaded",
                timeout=30000,
            )

            page.wait_for_timeout(3000)

            # If the persistent session was lost, fail clearly instead of
            # clicking around on a sign-in page.
            if "login" in page.url.lower() or "signin" in page.url.lower():
                return (
                    "Error: Outlook is not signed in for this Playwright profile. "
                    "Log in once using the existing ./outlook_profile session."
                )

            # Outlook should now show the compose form with subject, date,
            # start time, end time and location already populated by the URL.
            save_button = _first_existing(
                page.get_by_role("button", name="Save", exact=True),
                page.get_by_role("button", name="Enregistrer", exact=True),
                page.get_by_text("Save", exact=True),
                page.get_by_text("Enregistrer", exact=True),
            )

            if save_button is None:
                return (
                    "Error: Outlook event compose page opened, but the Save "
                    "button could not be found."
                )

            save_button.click()
            page.wait_for_timeout(1500)

            return (
                "Outlook event created successfully: "
                f"{subject} — {start_date} {start_time} to "
                f"{end_date} {end_time}"
                + (f" — {location}" if location else "")
            )

        except Exception as exc:
            return f"Error creating Outlook event: {exc}"

        finally:
            context.close()


# if __name__ == "__main__":
#     result = create_outlook_event(
#         subject="Test event from Python",
#         start_date="2026-08-20",
#         start_time="14:00",
#         end_date="2026-08-20",
#         end_time="15:00",
#         location="Québec",
#     )

#     print(result)