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
    "title": "New: one Map for Bus, MRT and Parking",
    "level": "update",
    "body": (
        "Switch between them under the search bar.\n"
        "• MRT: next trains, plus first and last train times\n"
        "• Parking: live free lots nearby\n"
        "• Saved: bus stops, stations and carparks in one place\n"
        "• Tap a bus to see when to leave, or the bell for an alert\n"
        "[img:whats-new/map-modes.webp]"
    ),
}

# Older notices folded into RELEASE_NOTE.
REPLACES = (
    "New: Can I make it?",
    "You can now get alerts before your bus comes",
    "What's new: one Map for Bus, MRT and Parking",  # earlier, longer draft
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
