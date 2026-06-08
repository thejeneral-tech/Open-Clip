import pytest

from app.services.ollama_client import OllamaError, extract_json, strip_reasoning


def test_strip_reasoning_removes_think_blocks():
    text = "<think>let me ponder this</think>\n{\"a\": 1}"
    assert strip_reasoning(text) == '{"a": 1}'


def test_extract_json_direct():
    assert extract_json('{"x": 5}') == {"x": 5}


def test_extract_json_from_fence():
    raw = "Here you go:\n```json\n{\"clips\": []}\n```\nDone."
    assert extract_json(raw) == {"clips": []}


def test_extract_json_with_leading_prose_and_think():
    raw = "<think>reasoning...</think> Sure! [1, 2, 3]"
    assert extract_json(raw) == [1, 2, 3]


def test_extract_json_slices_to_brackets():
    raw = 'noise {"k": "v"} trailing noise'
    assert extract_json(raw) == {"k": "v"}


def test_extract_json_raises_on_garbage():
    with pytest.raises(OllamaError):
        extract_json("absolutely not json")
