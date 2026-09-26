from pathlib import Path
from playwright.sync_api import sync_playwright


OUTLOOK_PROFILE = Path(__file__).resolve().parents[2] / "outlook_profile"


def login_outlook():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(OUTLOOK_PROFILE),
            headless=False,
        )

        page = context.pages[0] if context.pages else context.new_page()

        page.goto(
            "https://outlook.live.com/",
            wait_until="domcontentloaded",
        )

        print("Log into Outlook manually in the browser.")
        input("Once logged in, press Enter here to close the browser...")

        context.close()


if __name__ == "__main__":
    login_outlook()