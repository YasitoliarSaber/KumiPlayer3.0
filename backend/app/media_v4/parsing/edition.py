"""文件版本标记由结构上下文和单文件解析共用。"""

import re

_EDITION_TOKENS = (
    (re.compile(r"(?i)\bnon[ ._-]+trimming\b"), "non_trimming"),
    (re.compile(r"(?i)\(\s*on[ ._-]?air\s*(?:ver(?:sion)?\.?)?\s*\)"), "on-air"),
    (re.compile(r"(?i)(?:director(?:['’‘ʼ]s)?[ ._-]*cut|导演剪辑版)"), "director-cut"),
    (re.compile(r"(?i)(?:extended(?:[ ._-]?edition)?|加长版)"), "extended"),
    (re.compile(r"(?i)(?:remaster(?:ed)?|重制版)"), "remastered"),
    (re.compile(r"(?i)(?:theatrical(?:[ ._-]?cut)?|院线版)"), "theatrical"),
)


def edition_tags(stem: str) -> tuple[str, ...]:
    return tuple(tag for pattern, tag in _EDITION_TOKENS if pattern.search(stem))
