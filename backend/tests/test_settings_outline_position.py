"""宽屏设置大纲应在右侧留白内居中。"""

from pathlib import Path


def test_settings_outline_uses_the_current_sticky_desktop_and_horizontal_mobile_layout():
    styles = Path(__file__).resolve().parents[2] / "src" / "styles" / "settings-navigation.css"
    css = styles.read_text(encoding="utf-8")

    assert ".settings-focused {" in css
    assert "grid-template-columns: 184px minmax(0, 1fr) !important" in css
    assert ".settings-focused .settings-outline-popover-wrap" in css
    assert "position: sticky !important" in css
    assert "@media (max-width: 760px)" in css
    assert ".settings-focused .settings-outline-nav { display: flex; overflow-x: auto;" in css
