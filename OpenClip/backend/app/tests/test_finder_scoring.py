from app.services import finder_scoring as fs

_CAMPAIGN = {
    "name": "Rob the Bank Podcast Clips",
    "description": "Clip up the Rob the Bank podcast about money, hustle and mindset.",
    "category": "personal_brand",
    "requirements": ["30-60 second clips", "Must include #RobTheBank"],
    "platforms": ["tiktok", "youtube"],
}
_PAY = fs.PayoutCtx(rate_per_1k=1.0, min_payout=None, max_payout=50.0, remaining=26118.89)


def _ctx():
    return fs.build_campaign_ctx(_CAMPAIGN)


def test_build_campaign_ctx_parses_length_rule():
    ctx = _ctx()
    assert ctx.length_min == 30 and ctx.length_max == 60
    assert "money" in ctx.keywords and "bank" in ctx.keywords


def test_stage1_score_shape_and_weights():
    ctx = _ctx()
    cand = {"title": "Rob the Bank podcast full episode", "uploader": "Rob the Bank",
            "duration": 3600, "view_count": 250000}
    out = fs.score_stage1(ctx, cand, _PAY)
    assert 0 <= out["score"] <= 100
    assert 0 <= out["confidence"] <= 100
    assert out["stage"] == 1 and out["delta"] is None
    # The canonical weight vector sums to 100.
    assert round(sum(f["weight"] for f in out["factors"])) == 100
    # Stage 1 hasn't measured velocity/engagement/transcript → not full confidence.
    assert out["confidence"] < 80


def test_stage3_reranks_up_with_real_signals_and_confidence_rises():
    ctx = _ctx()
    cand = {"title": "Rob the Bank podcast full episode", "uploader": "Rob the Bank",
            "duration": 3600, "view_count": 250000}
    s1 = fs.score_stage1(ctx, cand, _PAY)
    enriched = {**cand, "description": "money hustle secret revealed",
                "tags": ["money", "podcast"], "like_count": 12000, "comment_count": 800,
                "upload_date": "20260601"}
    s3 = fs.score_stage3(ctx, enriched, _PAY, prev_score=s1["score"])
    assert s3["stage"] == 3
    assert s3["delta"] == s3["score"] - s1["score"]
    assert s3["confidence"] > s1["confidence"]          # more measured weight
    # Engagement + velocity are now real (measured) factors.
    measured = {f["key"] for f in s3["factors"] if f["measured"]}
    assert {"velocity", "engagement"} <= measured


def test_projected_payout_respects_max_payout_cap():
    ctx = _ctx()
    pay = fs.PayoutCtx(rate_per_1k=1.0, max_payout=10.0, remaining=1000.0)
    cand = {"title": "great money podcast", "uploader": "x", "duration": 1800, "view_count": 5_000_000}
    out = fs.score_stage1(ctx, cand, pay)
    assert out["projected_high"] is not None and out["projected_high"] <= 10.0


def test_brand_safety_flags_copyright_risk():
    ctx = _ctx()
    cand = {"title": "Official Music Video - Full Movie", "uploader": "VEVO",
            "duration": 240, "view_count": 100000}
    out = fs.score_stage1(ctx, cand, _PAY)
    brand = next(f for f in out["factors"] if f["key"] == "brand_safety")
    assert brand["value"] < 60
    assert any(r["kind"] == "warn" and "copyright" in r["text"].lower() for r in out["reasons"])


def test_short_video_penalized_on_retention():
    ctx = _ctx()
    short = {"title": "clip", "uploader": "x", "duration": 45, "view_count": 1000}
    long = {"title": "clip", "uploader": "x", "duration": 2400, "view_count": 1000}
    r_short = next(f for f in fs.score_stage1(ctx, short, _PAY)["factors"] if f["key"] == "retention")
    r_long = next(f for f in fs.score_stage1(ctx, long, _PAY)["factors"] if f["key"] == "retention")
    assert r_short["value"] < r_long["value"]


# --------------------------------------------------------- Stage 4 (transcript)
_ENRICHED = {
    "title": "Rob the Bank podcast", "uploader": "Rob the Bank", "duration": 3600,
    "view_count": 250000, "description": "money hustle mindset", "tags": ["money"],
    "like_count": 12000, "comment_count": 800, "upload_date": "20260601",
}
_TRANSCRIPT = {
    "text": "the secret to money is you never quit I was broke and terrified then I made "
    "my first million here is the shocking truth nobody tells you about cash",
    "segments": [
        {"start": 2.0, "text": "the secret to money is you never quit"},
        {"start": 10.0, "text": "I was broke and terrified"},
        {"start": 50.0, "text": "then I made my first million"},
        {"start": 120.0, "text": "the shocking truth nobody tells you about cash"},
    ],
}


def test_stage4_with_transcript_measures_everything_and_reaches_full_confidence():
    ctx = _ctx()
    s1 = fs.score_stage1(ctx, _ENRICHED, _PAY)
    s4 = fs.score_stage4(ctx, _ENRICHED, _PAY, transcript=_TRANSCRIPT, prev_score=s1["score"])
    assert s4["stage"] == 4
    measured = {f["key"] for f in s4["factors"] if f["measured"]}
    # With a transcript, transcript_match + hook flip to measured (were priors).
    assert {"transcript_match", "hook", "velocity", "engagement"} <= measured
    assert s4["confidence"] >= 90  # nearly all weight is now real data
    assert s4["delta"] == s4["score"] - s1["score"]


def test_stage4_extracts_a_best_moment():
    ctx = _ctx()
    s4 = fs.score_stage4(ctx, _ENRICHED, _PAY, transcript=_TRANSCRIPT)
    assert s4.get("best_moment_start") is not None
    assert s4["best_moment_end"] > s4["best_moment_start"]
    assert any("moment" in r["text"].lower() for r in s4["reasons"])


def test_stage4_without_captions_keeps_transcript_unmeasured():
    ctx = _ctx()
    s4 = fs.score_stage4(ctx, _ENRICHED, _PAY, transcript=None)
    measured = {f["key"] for f in s4["factors"] if f["measured"]}
    assert "transcript_match" not in measured
    assert s4["confidence"] < 95  # honest: missing transcript lowers confidence


def test_best_moment_none_without_segments():
    assert fs.best_moment(None, 100) is None
    assert fs.best_moment([], 100) is None


def test_heuristic_strategy_shape():
    # The guaranteed fallback the copilot degrades to when no model is reachable.
    videos = [{"url": "u", "title": "Rob the Bank podcast", "score": 79, "duration": 3600,
               "projected_low": 43.5, "projected_high": 174.2, "reasons": ["Strong match"]}]
    h = fs._heuristic_strategy({"name": "Rob the Bank"}, videos)
    assert h["source"] == "heuristic"
    assert h["opportunity_score"] == 79
    assert h["worth_joining"] is True
    assert "Rob the Bank" in h["headline"]
    assert "3 clips" in h["clip_plan"]  # long-form source → multi-clip plan


def test_echo_guard_rejects_prompt_parroting():
    assert fs._echoes("One punchy sentence on the best opportunity") is True
    assert fs._echoes("Clip the money segment at 0:42 — it's fire") is False
