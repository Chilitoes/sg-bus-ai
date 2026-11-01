"""
"What's new" notices shipped with the code.

On startup the newest release note is added to the notifications table (once,
matched by title) and promoted as a popup, and the older notices it replaces
are removed. To announce a later release, change RELEASE_NOTE and list the
titles it supersedes in REPLACES.
"""

import logging
from datetime import datetime

from database import SessionLocal, SystemNotification

logger = logging.getLogger(__name__)

RELEASE_NOTE = {
    "title": "What's new: one Map for Bus, MRT and Parking",
    "level": "update",
    "body": (
        "Bus, MRT and Parking now share one Map tab, so the bottom bar is "
        "tidier. Switch between them with the buttons under the search bar.\n"
        "\n"
        "• Parking: live free lots at carparks near you, or search by name. "
        "Log in to save carparks.\n"
        "• MRT: first and last trains for each station, with a warning when the "
        "last one is close. Scheduled times, not live.\n"
        "• Can I make it?: tap any bus to see when to leave. It counts in your "
        "walk and tells you to go, hurry, or catch the next one. \"Remind me "
        "when to leave\" pings you at the right time.\n"
        "• Bus alerts: tap the bell on a bus to get a ping about 2½ minutes "
        "before it arrives.\n"
        "• Crowding now reads Seats, Standing or Crowded.\n"
        "• Nicer maps, and better layouts in landscape and split screen.\n"
        "\n"
        "Plan a Journey is paused while it gets reworked.\n"
        "[img:whats-new/map-modes.webp]"
    ),
}

# Older notices folded into RELEASE_NOTE.
REPLACES = (
    "New: Can I make it?",
    "You can now get alerts before your bus comes",
)


def seed_release_notes() -> None:
    db = SessionLocal()
    try:
        if db.query(SystemNotification).filter_by(title=RELEASE_NOTE["title"]).first():
            return
        removed = (
            db.query(SystemNotification)
            .filter(SystemNotification.title.in_(REPLACES))
            .delete(synchronize_session=False)
        )
        now = datetime.utcnow()
        db.add(SystemNotification(**RELEASE_NOTE, created_at=now, popup_at=now))
        db.commit()
        logger.info("Release note posted: %s (replaced %d older notice(s))", RELEASE_NOTE["title"], removed)
    except Exception as exc:  # noqa: BLE001 — never block startup on this
        db.rollback()
        logger.warning("Could not post release note: %s", exc)
    finally:
        db.close()
