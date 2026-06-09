from app.services.ranking import rank_clip


class _Client:
    def __init__(self, payload):
        self.payload = payload

    def generate_json(self, prompt, *, model=None, system=None, schema=None, options=None, retries=2):
        return self.payload, {"model": "fake", "duration_ms": 1.0}


def test_rank_clip_uses_model_overall():
    client = _Client({
        "hook_strength": 80, "emotional_intensity": 70, "curiosity_gap": 60,
        "retention_likelihood": 65, "platform_suitability": 90,
        "overall_score": 77, "confidence": 85, "explanation": "great",
    })
    result, _ = rank_clip(title="t", text="x", duration=30, client=client)
    assert result["overall_score"] == 77
    assert result["confidence"] == 85
    assert result["explanation"] == "great"


def test_rank_clip_synthesizes_overall_when_missing():
    client = _Client({
        "hook_strength": 100, "emotional_intensity": 100, "curiosity_gap": 100,
        "retention_likelihood": 100, "platform_suitability": 100, "confidence": 50,
    })
    result, _ = rank_clip(title="t", text="x", duration=30, client=client)
    assert result["overall_score"] == 100.0  # weighted average of all-100s


def test_rank_clip_clamps_out_of_range():
    client = _Client({"hook_strength": 999, "overall_score": 250, "confidence": -5})
    result, _ = rank_clip(title="t", text="x", duration=30, client=client)
    assert 0 <= result["overall_score"] <= 100
    assert result["hook_strength"] == 100.0
    assert result["confidence"] == 0.0
