from app.services import campaign_finder as cf, youtube

_CAMPAIGN = {
    "name": "MrBeast Clips",
    "description": "clip mrbeast challenges and giveaways",
    "category": "entertainment",
    "requirements": [],
}

_CHANNEL_UPLOADS = [
    {"id": "a", "url": "ua", "title": "I gave away $1M", "duration": 600,
     "uploader": "MrBeast", "view_count": 9_000_000, "thumbnail": "t"},
    {"id": "b", "url": "ub", "title": "Last to leave wins", "duration": 900,
     "uploader": "MrBeast", "view_count": 8_000_000, "thumbnail": "t"},
]
_SEARCH_MIX = [
    {"id": "c", "url": "uc", "title": "MrBeast reaction!!", "duration": 300,
     "uploader": "Some Reactor", "channel": "Some Reactor", "channel_id": "UCZ", "view_count": 50_000},
    {"id": "a", "url": "ua", "title": "I gave away $1M", "duration": 600,
     "uploader": "MrBeast", "channel": "MrBeast", "channel_id": "UCX", "view_count": 9_000_000},
    {"id": "d", "url": "ud", "title": "MrBeast exposed", "duration": 200,
     "uploader": "DramaChannel", "channel": "DramaChannel", "channel_id": "UCW", "view_count": 30_000},
]


def _stub(monkeypatch):
    monkeypatch.setattr(youtube, "resolve_channel",
                        lambda q: {"ref": "https://youtube.com/@MrBeast", "name": "MrBeast", "channel_id": "UCX"})
    monkeypatch.setattr(youtube, "channel_videos", lambda ref, n: list(_CHANNEL_UPLOADS))
    monkeypatch.setattr(youtube, "search", lambda q, n: list(_SEARCH_MIX))


def test_strict_channel_keeps_only_the_creators_own_videos(monkeypatch):
    _stub(monkeypatch)
    out = cf.find_matches(_CAMPAIGN, use_llm=False, channel="MrBeast", strict_channel=True)
    uploaders = {m["uploader"] for m in out["matches"]}
    assert uploaders == {"MrBeast"}                      # reactor + drama channel dropped
    assert "only MrBeast" in out["understanding"]


def test_loose_channel_still_surfaces_others_but_ranks_creator_first(monkeypatch):
    _stub(monkeypatch)
    out = cf.find_matches(_CAMPAIGN, use_llm=False, channel="MrBeast", strict_channel=False)
    uploaders = [m["uploader"] for m in out["matches"]]
    assert "MrBeast" in uploaders and len(set(uploaders)) > 1  # others still present
    assert uploaders[0] == "MrBeast"                           # but the creator ranks first


def test_plain_name_is_resolved_to_a_channel(monkeypatch):
    # A plain creator NAME (not @handle/URL) should resolve to a channel whose
    # uploads are pulled — proven by the strict result being non-empty.
    _stub(monkeypatch)
    out = cf.find_matches(_CAMPAIGN, use_llm=False, channel="MrBeast", strict_channel=True)
    assert len(out["matches"]) >= 1
