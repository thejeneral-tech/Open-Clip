"""Unit tests for the YouTube → Workflow-Remake-Prompt builder core.

Pure logic only (no network / no Ollama): chunking guards, model resolution +
fallback, 500 error classification, safe payload building, reasoning-model text
cleanup, heuristic signal extraction, and emergency-template completeness — the
properties that keep a long transcript from ever crashing the feature.
"""

import pytest

from src import yt_workflow_builder as b


# --------------------------------------------------------------------------- #
# Chunking
# --------------------------------------------------------------------------- #

def test_chunk_small_text_is_single_chunk():
    assert b.chunk_text("hello world") == ["hello world"]


def test_chunk_respects_max_chars_including_overlap():
    text = ("Sentence number one here. " * 400 + "\n\n") * 6
    max_chars = 7000
    chunks = b.chunk_text(text, max_chars=max_chars)
    assert len(chunks) > 1
    # Every chunk (overlap included) stays within the cap.
    assert all(len(c) <= max_chars for c in chunks)


def test_chunk_hard_splits_a_giant_unbroken_paragraph():
    text = "x" * 50000  # no whitespace/punctuation at all
    chunks = b.chunk_text(text, max_chars=7000)
    assert len(chunks) >= 7
    assert all(len(c) <= 7000 for c in chunks)


def test_chunk_empty():
    assert b.chunk_text("") == []
    assert b.chunk_text("   \n  ") == []


# --------------------------------------------------------------------------- #
# Model resolution + fallback
# --------------------------------------------------------------------------- #

def test_resolve_requested_model_present():
    model, note, tried = b.resolve_model("deepseek-r1:8b", ["deepseek-r1:8b", "llama3.2:latest"])
    assert model == "deepseek-r1:8b"
    assert note == ""


def test_resolve_loose_match_family():
    # bare "llama3.2" should match installed "llama3.2:latest"
    model, _, _ = b.resolve_model("llama3.2", ["llama3.2:latest"])
    assert model == "llama3.2:latest"


def test_resolve_falls_back_when_requested_missing():
    model, note, _ = b.resolve_model("not-installed", ["deepseek-r1:8b"])
    assert model == "deepseek-r1:8b"
    assert "not available" in note


def test_resolve_returns_none_when_nothing_installed():
    model, note, tried = b.resolve_model("deepseek-r1:8b", [])
    assert model is None
    assert "Pull" in note or "pull" in note
    assert "deepseek-r1:8b" in tried


def test_resolve_fallbacks_only_installed():
    fbs = b.resolve_fallbacks("deepseek-r1:8b", ["deepseek-r1:8b", "llama3.2:latest"])
    assert fbs == ["llama3.2:latest"]  # qwen* not installed, primary excluded


# --------------------------------------------------------------------------- #
# 500 classification — the heart of memory-vs-context handling
# --------------------------------------------------------------------------- #

def test_classify_memory_error():
    body = ('{"error":"llama-server process has terminated: exit status 1: '
            'ggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer ... '
            'unable to allocate CPU buffer"}')
    assert b.classify_ollama_error(body) == "memory"


def test_classify_context_error():
    assert b.classify_ollama_error("prompt exceeds the maximum context length n_ctx") == "context"


def test_classify_generic_error():
    assert b.classify_ollama_error("something unexpected happened") == "generic"


# --------------------------------------------------------------------------- #
# Safe payload
# --------------------------------------------------------------------------- #

def test_build_payload_shape():
    p = b.build_generate_payload("deepseek-r1:8b", "hi", num_ctx=8192, temperature=0.2)
    assert p == {"model": "deepseek-r1:8b", "prompt": "hi", "stream": False,
                 "options": {"temperature": 0.2, "num_ctx": 8192}}
    # never sends null values
    assert all(v is not None for v in p.values())


def test_build_payload_rejects_empty_model_and_prompt():
    with pytest.raises(ValueError):
        b.build_generate_payload("", "hi")
    with pytest.raises(ValueError):
        b.build_generate_payload("m", "")
    with pytest.raises(ValueError):
        b.build_generate_payload(None, "hi")


def test_build_payload_omits_nonpositive_num_ctx():
    p = b.build_generate_payload("m", "hi", num_ctx=0)
    assert "num_ctx" not in p["options"]


# --------------------------------------------------------------------------- #
# Reasoning-model text cleanup
# --------------------------------------------------------------------------- #

def test_clean_strips_think_block():
    assert b.clean_model_text("<think>reasoning</think>\n\nAnswer.") == "Answer."


def test_clean_handles_unterminated_open_think():
    assert b.clean_model_text("<think>still thinking...") == "still thinking..."


def test_clean_strips_all_balanced_blocks_keeping_answer_text():
    # Balanced blocks are removed wherever they appear; surrounding answer text
    # is preserved (the realistic deepseek case is a single leading block).
    assert b.clean_model_text("<think>x</think>Hello <think>y</think>world") == "Hello world"


# --------------------------------------------------------------------------- #
# Heuristic signal extraction (powers offline emergency mode)
# --------------------------------------------------------------------------- #

def test_heuristics_extract_inline_commands_env_paths_ports():
    txt = ("Step 1: run: docker run -d -p 5678:5678 n8nio/n8n\n"
           "then pip install fastapi\n"
           "Set OLLAMA_HOST=0.0.0.0:11434 and API_KEY=sk-test in your .env\n"
           "Create src/app.py and routes/handler.py\n"
           "go to the next step and make sure node is installed\n"
           "if x == 5 then continue")
    sig = b.heuristic_signals(txt)
    assert any("docker run" in c for c in sig["commands"])
    assert "OLLAMA_HOST=0.0.0.0:11434" in sig["env_vars"]
    assert "API_KEY=sk-test" in sig["env_vars"]
    assert "src/app.py" in sig["file_paths"]
    assert "5678" in sig["ports"] and "11434" in sig["ports"]
    # prose must NOT be picked up as a command or env var
    assert not any("next step" in c for c in sig["commands"])
    assert not any(v.startswith("WHERE") for v in sig["env_vars"])


# --------------------------------------------------------------------------- #
# Emergency template — always the right shape, never empty
# --------------------------------------------------------------------------- #

def test_emergency_template_has_all_headings():
    src = b.extract_clean_source({
        "title": "Build a thing",
        "transcript": "Step 1: run docker compose up. Install ollama. Create src/main.py.",
    })
    out = b.emergency_template(src, b.GenDiag(selected_model="deepseek-r1:8b"))
    for heading in b.FINAL_TEMPLATE_HEADINGS:
        assert heading in out, f"missing heading: {heading}"


def test_extract_clean_source_counts_and_meta():
    src = b.extract_clean_source({"title": "T", "url": "https://youtu.be/x", "transcript": "abc def"})
    d = src.to_dict()
    assert d["meta"]["title"] == "T"
    assert d["char_count"] == len(d["source_text"])
    assert d["token_estimate"] >= 1


def test_estimate_tokens_roughly_quarter_of_chars():
    assert b.estimate_tokens("x" * 400) == 100


# --------------------------------------------------------------------------- #
# Friendly failure message adapts to the failure reason
# --------------------------------------------------------------------------- #

def test_friendly_message_memory_branch():
    diag = b.GenDiag(selected_model="deepseek-r1:8b", final_model="deepseek-r1:8b",
                     last_reason="memory", retry_count=4,
                     last_error_body="unable to allocate CPU buffer")
    msg = b.friendly_failure_message(diag, emergency=True)
    assert "ran out of memory" in msg
    assert "smaller model" in msg
    assert "unable to allocate CPU buffer" in msg
    assert "Retries: 4" in msg
