"""Pure-logic tests for the Whop session/sync helpers (no browser or DB)."""
from app.services import whop_session as ws
from app.services import whop_sync


def test_campaign_experience_regex_selects_the_right_app():
    m = ws._CAMPAIGN_EXP_RE.match
    # content-rewards / clipping-campaigns experiences ARE the campaigns app
    assert m("https://whop.com/joined/trendvault-f6c3/content-rewards-DrbBvUig75On0s/app/")
    assert m("https://whop.com/joined/theclipship/general-clipping-campaigns-gELKSum0xoWk9l/app/")
    assert m("https://whop.com/joined/robthebank-clips-2-0/content-rewards-1HEaQnm9iXywr7/app/")
    # chat / course / discover / landing experiences are NOT
    assert not m("https://whop.com/joined/x/ugc-chat-lBueYOu8bzMGav/app/")
    assert not m("https://whop.com/joined/x/clipping-course-uaSEtAQqTcTuA5/app/")
    assert not m("https://whop.com/joined/x/discover-campaigns-KxDsCzLDiwDSF1/app/")
    assert not m("https://whop.com/joined/x/find-content-rewards-get-paid-yS5qzg0halsW7l/app/")


def test_joined_whop_regex_extracts_slug():
    m = ws._JOINED_WHOP_RE.match("https://whop.com/joined/theclipship/general-clipping-campaigns-x/app/")
    assert m and m.group(1) == "theclipship"


def test_norm_matches_across_case_punctuation_emoji():
    assert whop_sync._norm("Sela Campbell | Movie Edits") == whop_sync._norm("sela campbell   movie edits")
    assert whop_sync._norm("🎯 Sela Campbell") == whop_sync._norm("Sela Campbell")
    assert whop_sync._norm("Mumford & Sons — Tour") == whop_sync._norm("mumford  sons  tour")
    assert whop_sync._norm(None) == ""
