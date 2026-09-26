from pathlib import Path

from playwright.sync_api import sync_playwright


OUTLOOK_PROFILE = (
    Path(__file__).resolve().parents[2]
    / "outlook_profile"
)

OUTLOOK_MAIL_URL = "https://outlook.live.com/mail/"


def _first_existing(*locators):
    for locator in locators:
        try:
            if locator.count() > 0:
                return locator.first
        except Exception:
            pass

    return None


def send_outlook_email(
    recipient: str,
    subject: str,
    body: str,
) -> str:

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(OUTLOOK_PROFILE),
            headless=False,
        )

        try:
            page = (
                context.pages[0]
                if context.pages
                else context.new_page()
            )

            page.goto(
                OUTLOOK_MAIL_URL,
                wait_until="domcontentloaded",
                timeout=30000,
            )

            page.wait_for_timeout(4000)

            current_url = page.url.lower()

            if (
                "login.live.com" in current_url
                or "login.microsoftonline.com" in current_url
            ):
                return (
                    "Error: Outlook session has expired. "
                    "Run outlook_login.py and log in again."
                )

            # ---------------------------------------------------------
            # New message
            # ---------------------------------------------------------

            new_message = _first_existing(
                page.get_by_role(
                    "button",
                    name="Nouveau message",
                    exact=True,
                ),
                page.get_by_role(
                    "button",
                    name="New mail",
                    exact=True,
                ),
            )

            if new_message is None:
                return "Error: Could not find the Nouveau message button."

            new_message.click()
            page.wait_for_timeout(1200)

            # ---------------------------------------------------------
            # Recipient
            # ---------------------------------------------------------

            to_field = page.locator(
                'div[contenteditable="true"][aria-label="À"]'
            ).first

            if to_field.count() == 0:
                to_field = page.locator(
                    'div[contenteditable="true"][aria-label="To"]'
                ).first

            if to_field.count() == 0:
                return "Error: Could not find the recipient field."

            to_field.click()
            to_field.fill(recipient)

            page.wait_for_timeout(500)

            # Commit recipient
            to_field.press("Enter")

            page.wait_for_timeout(300)

            # ---------------------------------------------------------
            # Subject
            # ---------------------------------------------------------

            subject_field = page.locator(
                'input[aria-label="Sujet"]'
            ).first

            if subject_field.count() == 0:
                subject_field = page.locator(
                    'input[aria-label="Subject"]'
                ).first

            if subject_field.count() == 0:
                return "Error: Could not find the subject field."

            subject_field.fill(subject)

            # ---------------------------------------------------------
            # Body
            # ---------------------------------------------------------

            body_field = page.locator(
                '[role="textbox"]'
                '[aria-label="Corps du message"]'
                '[contenteditable="true"]'
            ).first

            if body_field.count() == 0:
                body_field = page.locator(
                    '[role="textbox"]'
                    '[aria-label="Message body"]'
                    '[contenteditable="true"]'
                ).first

            if body_field.count() == 0:
                return "Error: Could not find the message body."

            body_field.click()

            # Move before Outlook's existing signature
            body_field.press("Control+Home")

            # Preserve multiline messages
            lines = body.splitlines()

            if not lines:
                lines = [""]

            for index, line in enumerate(lines):
                if line:
                    body_field.type(line)

                if index < len(lines) - 1:
                    body_field.press("Shift+Enter")

            # Add separation before the existing signature
            body_field.press("Enter")
            body_field.press("Enter")

            page.wait_for_timeout(300)

            # ---------------------------------------------------------
            # Send
            # ---------------------------------------------------------

            send_button = _first_existing(
                page.get_by_role(
                    "button",
                    name="Envoyer",
                    exact=True,
                ),
                page.get_by_role(
                    "button",
                    name="Send",
                    exact=True,
                ),
            )

            if send_button is None:
                return "Error: Could not find the Send button."

            send_button.click()

            page.wait_for_timeout(1500)

            return (
                "Outlook email sent successfully: "
                f"{recipient} — {subject}"
            )

        except Exception as exc:
            return f"Error sending Outlook email: {exc}"

        finally:
            context.close()


# ---------------------------------------------------------------------
# Manual test
# ---------------------------------------------------------------------

# if __name__ == "__main__":
#     print("Manual Outlook email test")
#     print("-------------------------")

# recipient = input("Recipient: ").strip()
#     subject = "test"#input("Subject: ").strip()

#     body = "Hello Test"

#     print()
#     print("About to send:")
#     print(f"To: {recipient}")
#     print(f"Subject: {subject}")
#     print("Body:")
#     print(body)

#     confirm = input(
#         "\nSend this email? [y/N]: "
#     ).strip().lower()

#     if confirm == "y":
#         result = send_outlook_email(
#             recipient=recipient,
#             subject=subject,
#             body=body,
#         )

#         print(result)

#     else:
#         print("Cancelled.")