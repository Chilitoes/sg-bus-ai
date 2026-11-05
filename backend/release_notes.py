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
    "title": "New: live 3D buses on the map",
    "level": "update",
    "body": (
        "See your bus driving towards your stop, on a 3D map.\n"
        "• Buses near you show up straight away\n"
        "• Tap a bus in the timeline to find it on the map\n"
        "• Bus route: see every stop, and get pinged one stop before yours\n"
        "• Alerts now arrive even with the app closed\n"
        "[img:whats-new/live-buses.webp]"
    ),
}

# Older notices folded into RELEASE_NOTE.
REPLACES = (
    "New: Can I make it?",
    "You can now get alerts before your bus comes",
    "What's new: one Map for Bus, MRT and Parking",
    "New: one Map for Bus, MRT and Parking",
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
