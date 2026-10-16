"""V4 共用的英文序数季标记，不从单独序数或普通标题数字推断季度。"""

import re

ORDINAL_SEASONS = {
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
    "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
}
ORDINAL_SEASON_PATTERN = (
    r"(?<![A-Za-z0-9])(" + "|".join(ORDINAL_SEASONS) + r")\s+season"
    r"(?=$|[\s._-]*[\[(]|[\s._-]+(?:\d{1,3}|E\d+)(?![A-Za-z0-9]))"
)
ORDINAL_SEASON_RE = re.compile(ORDINAL_SEASON_PATTERN, re.IGNORECASE)


def ordinal_season_number(value: str) -> int | None:
    match = ORDINAL_SEASON_RE.search(value)
    return ORDINAL_SEASONS[match.group(1).casefold()] if match else None
