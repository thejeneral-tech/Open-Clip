"""Unit tests for requirements extraction (pure — no network, DB, or Ollama)."""
from app.api.v1.endpoints import whop as whop_endpoints
from app.schemas.whop import WhopRequirementsIn
from app.services import whop_requirements as wr


# ----------------------------------------------------------------- link finding
def test_find_doc_links_keeps_briefs_drops_media_and_social():
    text = (
        "Full brief: https://docs.google.com/document/d/ABC123/edit?tab=t.0 . "
        "Clip this https://youtube.com/watch?v=xyz and this https://example.com/a.mp4 — "
        "notes at https://notion.so/page-123, asset https://drive.google.com/file/d/XYZ/view"
    )
    links = wr.find_doc_links(text)
    assert "https://docs.google.com/document/d/ABC123/edit?tab=t.0" in links
    assert "https://notion.so/page-123" in links
    # media, social and bare Drive *file* assets are never a requirements brief
    assert all("youtube" not in u for u in links)
    assert all(not u.endswith(".mp4") for u in links)
    assert all("drive.google.com/file" not in u for u in links)


def test_find_doc_links_strips_trailing_punctuation_and_dedupes():
    text = "see https://notion.so/x). also (https://notion.so/x)"
    assert wr.find_doc_links(text) == ["https://notion.so/x"]


def test_find_doc_links_empty():
    assert wr.find_doc_links("") == []
    assert wr.find_doc_links(None) == []


# ------------------------------------------------------------ google doc export
def test_google_doc_text_url_maps_edit_and_published():
    assert (
        wr.google_doc_text_url("https://docs.google.com/document/d/ABC123/edit?tab=t.0")
        == "https://docs.google.com/document/d/ABC123/export?format=txt"
    )
    assert (
        wr.google_doc_text_url("https://docs.google.com/document/d/e/2PACX-99/pub")
        == "https://docs.google.com/document/d/2PACX-99/export?format=txt"
    )
    assert wr.google_doc_text_url("https://notion.so/page") is None


# ------------------------------------------------------------------ html → text
def test_html_to_text_drops_script_and_style():
    html = (
        "<html><head><style>.a{color:red}</style></head>"
        "<body><p>Use the official sound</p><script>evil()</script>"
        "<li>Minimum 15 seconds</li></body></html>"
    )
    text = wr.html_to_text(html)
    assert "Use the official sound" in text
    assert "Minimum 15 seconds" in text
    assert "evil()" not in text
    assert "color:red" not in text


# ---------------------------------------------------------------- ssrf guard
def test_host_is_public_blocks_private_and_loopback():
    assert wr._host_is_public("127.0.0.1") is False
    assert wr._host_is_public("10.1.2.3") is False
    assert wr._host_is_public("192.168.0.5") is False
    assert wr._host_is_public("169.254.1.1") is False
    assert wr._host_is_public("8.8.8.8") is True          # public resolver IP literal


# ------------------------------------------------------------ google doc fetch
class _FakeResp:
    def __init__(self, status: int, ctype: str, content: bytes):
        self.status_code = status
        self.headers = {"content-type": ctype}
        self.content = content
        self.encoding = "utf-8"


def test_fetch_document_text_reads_public_gdoc_export(monkeypatch):
    monkeypatch.setattr(
        wr, "_safe_get",
        lambda url: _FakeResp(200, "text/plain; charset=utf-8", b"Rule one\nRule two"),
    )
    text = wr.fetch_document_text("https://docs.google.com/document/d/PUB/edit")
    assert "Rule one" in text and "Rule two" in text


def test_fetch_document_text_rejects_private_gdoc_login_page(monkeypatch):
    # A non-public doc's export redirects to an HTML sign-in page — must NOT be used.
    monkeypatch.setattr(
        wr, "_safe_get",
        lambda url: _FakeResp(200, "text/html", b"<html><body>Sign in</body></html>"),
    )
    assert wr.fetch_document_text("https://docs.google.com/document/d/PRIV/edit") == ""


# -------------------------------------------------------- structured parsing
def test_structured_parses_formatted_brief():
    brief = (
        "🎬 Content Requirements:\n"
        "* Length: Videos must be at least 8 seconds long.\n"
        "* Hashtags: #blonde #selacampbell\n"
        "* Platform: TikTok, Instagram, YouTube shorts\n"
        "NOTE 1: don't use AI generated cover photos.\n"
    )
    reqs = wr.structured_requirements(brief)
    assert "Length: Videos must be at least 8 seconds long." in reqs
    assert "Hashtags: #blonde #selacampbell" in reqs
    assert "Platform: TikTok, Instagram, YouTube shorts" in reqs
    assert any(r.startswith("NOTE 1") and "AI generated" in r for r in reqs)


def test_structured_skips_resource_lists():
    brief = (
        "Approved movies/shows:\n"
        "* Legally Blonde\n"
        "* A Cinderella Story\n"
        "Content Requirements:\n"
        "* Hashtags: #blonde\n"
    )
    reqs = wr.structured_requirements(brief)
    assert reqs == ["Hashtags: #blonde"]          # movie titles are resources, not rules


def test_structured_returns_empty_for_prose():
    assert wr.structured_requirements(
        "We are excited to work with talented creators who make fun edits."
    ) == []


# ---------------------------------------------------------------- link surfacing
def test_label_for_link():
    assert wr._label_for_link("https://docs.google.com/document/d/A/edit") == "Google Doc"
    assert wr._label_for_link("https://drive.google.com/drive/folders/X") == "Google Drive"
    assert wr._label_for_link("https://forms.gle/abc") == "Google Form"
    assert wr._label_for_link("https://www.notion.so/Brief") == "Notion"
    assert wr._label_for_link("https://6ix.com/events") == "6ix.com"


def test_detect_links_labels_and_filters_media_social():
    brief = (
        "Brief: https://docs.google.com/document/d/DOC/edit  "
        "Assets: https://drive.google.com/drive/folders/F  "
        "Watch: https://youtube.com/watch?v=z  Clip: https://x.com/a/b"
    )
    links = wr.detect_links(brief)
    urls = [item["url"] for item in links]
    assert {"label": "Google Doc", "url": "https://docs.google.com/document/d/DOC/edit"} in links
    assert any(item["label"] == "Google Drive" for item in links)
    assert all("youtube" not in u and "x.com" not in u for u in urls)   # social dropped


def test_extract_returns_openable_links(monkeypatch):
    monkeypatch.setattr(wr, "fetch_document_text", lambda url: "")
    monkeypatch.setattr(wr, "_llm_requirements", lambda brief, *, model, timeout: None)
    result = wr.extract_requirements(
        "See the brief: https://docs.google.com/document/d/DOC/edit"
    )
    assert result["links"] == [
        {"label": "Google Doc", "url": "https://docs.google.com/document/d/DOC/edit"}
    ]


# ------------------------------------------------------------- headless render
def test_extract_renders_whop_page_for_requirements_and_links(monkeypatch):
    # Simulate headless Chrome returning a formatted requirements page + a doc anchor.
    monkeypatch.setattr(
        wr.whop_render, "render_page",
        lambda url, **k: {
            "text": "Content Requirements:\n* Hashtags: #blonde\n* Length: at least 8 seconds",
            "hrefs": ["https://docs.google.com/document/d/DOC/edit", "https://youtube.com/watch?v=x"],
        },
    )
    monkeypatch.setattr(wr, "fetch_document_text", lambda url: "")   # doc fetch not needed here
    monkeypatch.setattr(wr, "_llm_requirements", lambda *a, **k: None)

    res = wr.extract_requirements(None, "https://whop.com/some-campaign")
    assert res["source"] == "structured"
    assert any("blonde" in r.lower() for r in res["requirements"])
    # the Google Doc anchor is surfaced as an openable link; the YouTube one is dropped
    assert {"label": "Google Doc", "url": "https://docs.google.com/document/d/DOC/edit"} in res["links"]
    assert all("youtube" not in link["url"] for link in res["links"])


def test_extract_render_disabled_returns_empty(monkeypatch):
    # render=False and no pasted text → nothing to work with.
    monkeypatch.setattr(wr, "_llm_requirements", lambda *a, **k: None)
    res = wr.extract_requirements(None, "https://whop.com/x", render=False)
    assert res == {"requirements": [], "documents": [], "links": [], "source": "none"}


# --------------------------------------------------------- extract orchestration
def test_extract_prefers_structured_and_skips_llm(monkeypatch):
    def boom_llm(*a, **k):
        raise AssertionError("the model must not run when the brief is already structured")

    monkeypatch.setattr(wr, "fetch_document_text", lambda url: "")
    monkeypatch.setattr(wr, "_llm_requirements", boom_llm)

    result = wr.extract_requirements(
        "Content Requirements:\n* Hashtags: #blonde\n* Length: at least 8 seconds"
    )
    assert result["source"] == "structured"
    assert any("blonde" in r.lower() for r in result["requirements"])


def test_extract_uses_llm_for_prose_and_reads_linked_doc(monkeypatch):
    seen_brief = {}

    def fake_fetch(url: str) -> str:
        assert url == "https://docs.google.com/document/d/DOC/edit"
        return "We want authentic energetic edits that feel true to the brand."   # prose

    def fake_llm(brief: str, *, model, timeout):
        seen_brief["brief"] = brief
        return ["Use the official sound", "Keep the video vertical"]

    monkeypatch.setattr(wr, "fetch_document_text", fake_fetch)
    monkeypatch.setattr(wr, "_llm_requirements", fake_llm)

    result = wr.extract_requirements(
        "Check the vibe. Full brief: https://docs.google.com/document/d/DOC/edit",
        "https://whop.com/x",
        render=False,                              # don't launch a real browser in tests
    )
    assert result["source"] == "llm"               # prose brief → structured found nothing
    assert result["requirements"] == ["Use the official sound", "Keep the video vertical"]
    assert result["documents"] == ["https://docs.google.com/document/d/DOC/edit"]
    # the linked doc's text was folded into the brief handed to the model
    assert "authentic energetic edits" in seen_brief["brief"].lower()


def test_extract_falls_back_to_heuristic_when_no_model(monkeypatch):
    monkeypatch.setattr(wr, "fetch_document_text", lambda url: "")
    monkeypatch.setattr(wr, "_llm_requirements", lambda brief, *, model, timeout: None)

    # Rule-shaped prose the strict structured pass skips but the loose heuristic keeps.
    desc = (
        "Welcome clippers!\n"
        "Minimum 15 seconds per clip.\n"
        "Include your handle in the caption.\n"
        "We love creative edits."          # no rule signal → dropped
    )
    result = wr.extract_requirements(desc)
    assert result["source"] == "heuristic"
    joined = " ".join(result["requirements"]).lower()
    assert "minimum 15 seconds" in joined
    assert "include your handle" in joined
    assert "we love creative edits" not in joined


def test_extract_empty_description_short_circuits(monkeypatch):
    called = False

    def boom(*a, **k):
        nonlocal called
        called = True
        return None

    monkeypatch.setattr(wr, "_llm_requirements", boom)
    result = wr.extract_requirements("   ")
    assert result == {"requirements": [], "documents": [], "links": [], "source": "none"}
    assert called is False


def test_clean_items_strips_bullets_dedupes_and_caps():
    items = ["- Use the sound", "1. Use the sound", "• Tag @me", "x" * 500, ""]
    cleaned = wr._clean_items(items)
    assert cleaned == ["Use the sound", "Tag @me"]        # bullet/number stripped, dupe + overlong dropped


# ------------------------------------------------------------------- endpoint
async def test_endpoint_returns_empty_without_description_or_url():
    body = WhopRequirementsIn(description=None, whop_url=None)
    out = await whop_endpoints.extract_requirements(body=body, current_user=None)
    assert out.requirements == []
    assert out.source == "none"


async def test_endpoint_runs_extractor(monkeypatch):
    def fake_extract(description, whop_url, *, model):
        assert "sound" in description
        return {"requirements": ["Use the official sound"], "documents": [], "source": "llm"}

    monkeypatch.setattr(wr, "extract_requirements", fake_extract)
    body = WhopRequirementsIn(description="Use the official sound", whop_url=None)
    out = await whop_endpoints.extract_requirements(body=body, current_user=None)
    assert out.requirements == ["Use the official sound"]
    assert out.source == "llm"
