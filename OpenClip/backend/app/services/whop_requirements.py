"""Distill a campaign's posting requirements from its description + any linked docs.

A Whop campaign page renders its Requirements section client-side, so a server-side
fetch of the page only yields the OpenGraph summary — the actual rules aren't in the
HTML. But the campaign's *description* (which the importer already pulls into the form)
usually spells the rules out, and very often links to a Google Doc / brief that holds
the full list. This service reads that description, FOLLOWS the document links it finds
(Google Docs export, or a plain public page → text), and asks the local LLM to turn the
combined text into a short, deduped list of imperative requirement bullets.

Blocking (sync ``httpx`` + Ollama), so call :func:`extract_requirements` off the event
loop (``asyncio.to_thread``). It degrades gracefully at every step: no links → the
description alone; no/slow Ollama → a conservative heuristic split; nothing usable → [].
No new dependencies — httpx and the Ollama client are already used across the app.

Following links from arbitrary text is an SSRF surface, so every fetch (each redirect
hop included) is checked to resolve to a *public* IP and restricted to http(s).
"""
from __future__ import annotations

import html
import ipaddress
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

from app.core.logging import get_logger
from app.services import whop_render
from app.services.campaign_finder import _resolve_finder_model

logger = get_logger(__name__)

_DOC_TIMEOUT = httpx.Timeout(6.0)
_MAX_REDIRECTS = 4
_MAX_DOC_BYTES = 400_000        # cap the download of any single linked doc
_MAX_DOC_CHARS = 6_000          # cap the text kept from any single doc
_MAX_TOTAL_CHARS = 12_000       # cap the combined brief handed to the model
_MAX_DOCS = 2                   # follow at most this many links per campaign
_USER_AGENT = (
    "Mozilla/5.0 (compatible; OpenClipBot/1.0; +https://openclip.local) "
    "AppleWebKit/537.36 (KHTML, like Gecko)"
)
_HEADERS = {"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain"}

_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.IGNORECASE)
# Media / social links are never a requirements brief — they're the raw asset to clip
# or a share target, so we never fetch them for text.
_SKIP_HOST_RE = re.compile(
    r"(?:^|\.)(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|twitter\.com|x\.com"
    r"|facebook\.com|fb\.watch|twitch\.tv|spotify\.com|apple\.com|whop\.com)$",
    re.IGNORECASE,
)
_MEDIA_EXT_RE = re.compile(
    r"\.(?:mp4|mov|m4v|webm|mp3|wav|m4a|png|jpe?g|gif|webp|svg|zip|rar|7z|dmg|exe)(?:$|[?#])",
    re.IGNORECASE,
)
# Google Docs document id, from either /document/d/<id>/ or /document/d/e/<id>/pub.
_GDOC_RE = re.compile(r"docs\.google\.com/document/d/(?:e/)?([A-Za-z0-9_-]+)", re.IGNORECASE)


# --------------------------------------------------------------- link handling
def _is_doc_url(url: str) -> bool:
    """True if ``url`` plausibly holds a requirements brief (media/social/asset dropped)."""
    host = (urlparse(url).hostname or "").lower()
    if not host or _SKIP_HOST_RE.search(host) or _MEDIA_EXT_RE.search(url):
        return False
    # A bare Google *Drive file* is an asset (video/pdf), not a doc brief — skip it;
    # Google Docs (docs.google.com/document) are the real briefs and are kept.
    return not (host.endswith("drive.google.com") and "/file/" in url)


def _doc_urls(urls) -> list[str]:
    """Dedupe an iterable of raw URLs down to followable doc links (order preserved)."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in urls:
        url = (raw or "").rstrip(".,);]}'\"")   # trailing sentence punctuation
        if not _is_doc_url(url):
            continue
        key = url.lower()
        if key not in seen:
            seen.add(key)
            out.append(url)
    return out


def find_doc_links(text: str | None) -> list[str]:
    """URLs in the text that plausibly hold a requirements brief (media/social dropped)."""
    return _doc_urls(_URL_RE.findall(text or ""))


def _label_for_link(url: str) -> str:
    """A short human label for a resource link ("Google Doc", "Notion", host…)."""
    host = (urlparse(url).hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    low = url.lower()
    if "docs.google.com" in host:
        if "/document/" in low:
            return "Google Doc"
        if "/spreadsheets/" in low:
            return "Google Sheet"
        if "/presentation/" in low:
            return "Google Slides"
        if "/forms/" in low:
            return "Google Form"
        return "Google Docs"
    if "forms.gle" in host:
        return "Google Form"
    if "drive.google.com" in host:
        return "Google Drive"
    if "notion.so" in host or "notion.site" in host:
        return "Notion"
    if "dropbox.com" in host:
        return "Dropbox"
    return host or "Link"


def _label_links(urls, *, cap: int = 6) -> list[dict[str, str]]:
    """Filter + label an iterable of URLs into ``[{"label", "url"}]`` (openable only).

    Broader than :func:`_doc_urls` (which is tuned for fetching text): keeps Google Drive
    files and forms too, since the point is to give the user something to *open*. Still
    drops social/media links.
    """
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in urls:
        url = (raw or "").rstrip(".,);]}'\"")
        host = (urlparse(url).hostname or "").lower()
        if not host or len(url) > 500 or _SKIP_HOST_RE.search(host) or _MEDIA_EXT_RE.search(url):
            continue
        key = url.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"label": _label_for_link(url), "url": url})
        if len(out) >= cap:
            break
    return out


def detect_links(text: str | None, *, cap: int = 6) -> list[dict[str, str]]:
    """Openable resource links found in free text, each labelled."""
    return _label_links(_URL_RE.findall(text or ""), cap=cap)


def google_doc_text_url(url: str) -> str | None:
    """Map a Google Docs link to its plain-text export URL, else None.

    ``…/document/d/<id>/edit`` and published ``…/document/d/e/<id>/pub`` links both
    become ``…/export?format=txt``, which returns the doc body as UTF-8 text with no
    auth as long as the doc is shared to anyone-with-the-link (the norm for briefs).
    """
    m = _GDOC_RE.search(url or "")
    if not m:
        return None
    return f"https://docs.google.com/document/d/{m.group(1)}/export?format=txt"


def _host_is_public(host: str) -> bool:
    """True only if every address ``host`` resolves to is a routable public IP.

    Blocks loopback/private/link-local/reserved ranges so a link in a campaign
    description can't be used to reach internal services (SSRF).
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_reserved or ip.is_multicast or ip.is_unspecified
        ):
            return False
    return True


def _safe_get(url: str) -> httpx.Response | None:
    """GET ``url`` following redirects manually, checking each hop is a public http(s)
    host. Returns the final response, or None if a hop is unsafe/unreachable."""
    current = url
    with httpx.Client(timeout=_DOC_TIMEOUT, follow_redirects=False, headers=_HEADERS) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            parsed = urlparse(current)
            if parsed.scheme not in ("http", "https"):
                return None
            host = parsed.hostname or ""
            if not host or not _host_is_public(host):
                logger.info("Requirements: refusing to fetch non-public/blocked host %r", host)
                return None
            try:
                resp = client.get(current)
            except httpx.HTTPError as exc:
                logger.info("Requirements: fetch failed for %r: %s", current, exc)
                return None
            if resp.is_redirect and resp.headers.get("location"):
                current = urljoin(current, resp.headers["location"])
                continue
            return resp
    return None


class _TextParser(HTMLParser):
    """Collect visible text from an HTML page, skipping script/style/head noise."""

    _SKIP = {"script", "style", "noscript", "template", "svg", "head"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in ("br", "p", "li", "div", "tr", "h1", "h2", "h3", "h4"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data.strip():
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self.parts)).strip()


def html_to_text(markup: str) -> str:
    parser = _TextParser()
    try:
        parser.feed(markup)
    except Exception:                       # a malformed page shouldn't kill extraction
        return ""
    return parser.text()


def fetch_document_text(url: str) -> str:
    """Fetch a linked doc and return its text (empty on any failure)."""
    export = google_doc_text_url(url)
    resp = _safe_get(export or url)
    if resp is None or resp.status_code >= 400:
        return ""
    ctype = resp.headers.get("content-type", "").lower()
    body = resp.content[:_MAX_DOC_BYTES]
    try:
        text = body.decode(resp.encoding or "utf-8", errors="replace")
    except (LookupError, ValueError):
        text = body.decode("utf-8", errors="replace")
    if export:
        # A real Google Docs export is text/plain. If it came back as HTML, the doc
        # isn't publicly shared (Google redirected to a sign-in page) — don't mistake
        # that login page for the brief; signal failure so the user pastes the text.
        if "text/plain" not in ctype:
            return ""
        cleaned = text
    elif "text/plain" in ctype:
        cleaned = text
    elif "html" in ctype or "<html" in text[:500].lower():
        cleaned = html_to_text(text)
    else:                                    # unknown binary-ish content — not a brief
        return ""
    cleaned = html.unescape(cleaned).strip()
    return cleaned[:_MAX_DOC_CHARS]


# ------------------------------------------------------------------- LLM layer
_LLM_SYSTEM = (
    "You extract the concrete posting requirements a creator MUST follow to get their "
    "submission approved and paid for a short-form clipping / UGC campaign. Return ONLY JSON."
)
_LLM_USER = """From the campaign brief below, list the specific rules a post must follow.

Guidance:
- Each item is one short, imperative rule (max ~140 chars), e.g. "Use the official sound",
  "Minimum 15 seconds", "Post on TikTok and Instagram Reels", "Include #Blonde in the caption",
  "Tag @selacampbell", "No visible watermarks", "Only clip the provided footage".
- Include ONLY real requirements. Exclude marketing copy, greetings, the reward rate / budget /
  payout, and anything that isn't a rule the creator has to obey.
- Deduplicate and keep the creator's own wording where possible.
- If the brief states no clear requirements, return an empty list.

BRIEF:
{brief}

Return ONLY JSON: {{"requirements": ["rule", "rule"]}}"""

_LLM_SCHEMA = {
    "type": "object",
    "properties": {"requirements": {"type": "array", "items": {"type": "string"}}},
    "required": ["requirements"],
}


def _clean_items(value: object) -> list[str]:
    """Normalise the model / heuristic output into tidy, deduped, bounded bullets."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item).strip() if item is not None else ""
        text = re.sub(r"^\s*(?:[-*•\d.)\]]+\s*)+", "", text).strip()   # strip bullet/number prefixes
        text = re.sub(r"\s+", " ", text)
        if not text or len(text) > 280:
            continue
        key = text.lower()
        if key not in seen:
            seen.add(key)
            out.append(text)
        if len(out) >= 25:                  # matches the campaign schema's cap
            break
    return out


def _llm_requirements(brief: str, *, model: str | None, timeout: int) -> list[str] | None:
    """Ask the local model to distil the brief into requirement bullets. None on failure."""
    from app.services.ollama_client import OllamaClient

    client = OllamaClient(timeout=timeout)
    resolved = _resolve_finder_model(model, client)
    if not resolved:
        return None
    try:
        parsed, _meta = client.generate_json(
            _LLM_USER.format(brief=brief[:_MAX_TOTAL_CHARS]),
            model=resolved,
            system=_LLM_SYSTEM,
            schema=_LLM_SCHEMA,
            options={"temperature": 0.2, "num_ctx": 4096},
            retries=0,
        )
    except Exception as exc:
        logger.info("Requirements LLM unavailable (%s); using heuristic", exc)
        return None
    if not isinstance(parsed, dict):
        return None
    return _clean_items(parsed.get("requirements"))


# Signals that a line is a rule rather than prose — used only for the no-LLM fallback.
_RULE_HINT = re.compile(
    r"\b(must|should|need to|required|require|do not|don't|no |only |use the|include|tag |"
    r"mention|hashtag|caption|minimum|at least|max|maximum|seconds?|duration|post on|"
    r"official sound|credit|watermark|link in bio|follow )\b",
    re.IGNORECASE,
)


def _heuristic_requirements(brief: str) -> list[str]:
    """Conservative fallback when no model is available: keep the rule-shaped lines.

    Splits the brief into lines/sentences and keeps only those that read like a rule,
    so we never flood the campaign with the whole description as "requirements".
    """
    candidates: list[str] = []
    for line in re.split(r"[\n\r]+|(?<=[.!?])\s+(?=[A-Z0-9#@])", brief):
        line = line.strip(" \t-*•")
        if 3 <= len(line) <= 200 and _RULE_HINT.search(line):
            candidates.append(line)
    return _clean_items(candidates)[:12]


# ---------------------------------------------------------- structured parsing
# Most Whop briefs are already formatted as a rules list ("Content Requirements:"
# with bullets, "Field: value" specs, and NOTE lines), so a deterministic parse is
# faster and more reliable than a model — and never hangs on a slow local GPU.
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U0000FE00-\U0000FE0F\U0000200D\U00002122\U00002139]"
)
_BULLET = re.compile(r"^\s*(?:[-*•▪◦·‣⁃]|\d+[.)])\s+(.*)")
# Bullets under these headings are RESOURCES to use (movies/assets/audio), not rules.
_RESOURCE_HEAD = re.compile(r"approved\s+(?:movies|shows|assets|audio|content)|assets?\s+folder", re.I)
# Prefixed lines that are rules even without a bullet ("NOTE 1: …", "Approvals: …").
_LABEL_LINE = re.compile(
    r"^\s*(NOTE\s*\d*|P\.?\s?S\.?|Approvals?|Posting|General|Length|Hashtags?|Platforms?|"
    r"Audience|Language|Engagement(?:\s*Rate)?|Comments?)\s*[:.\-–]\s*(.+)",
    re.I,
)
# Free-standing sentences that are clearly a rule even when not bulleted/labelled.
_RULE_SENTENCE = re.compile(
    r"\b(you must|must use|must attach|must include|you can only|do not|don'?t|"
    r"no nsfw|only submit|only post|not allowed|will be rejected)\b",
    re.I,
)


def _tidy(line: str) -> str:
    line = _EMOJI.sub("", line)
    line = re.sub(r"\s+", " ", line).strip()
    return line.strip(" \t-–—*•:;,")


def structured_requirements(brief: str) -> list[str]:
    """Pull the rule lines out of a formatted brief, deterministically.

    Keeps bulleted items, ``Field: value`` specs and NOTE/rule lines, but skips the
    "approved movies / assets / audio" lists (those are source material, not rules).
    Returns [] when the brief has no rule-shaped lines (pure prose → let the model try).
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(text: str) -> None:
        text = _tidy(text)
        if not text or len(text) < 3 or len(text) > 280:
            return
        key = text.lower()
        if key not in seen:
            seen.add(key)
            out.append(text)

    section = ""
    for raw in brief.splitlines():
        line = raw.strip()
        if not line:
            continue
        # A short line ending in ":" is a section heading — track it so we can skip
        # resource lists that follow.
        if line.endswith(":") and len(line.split()) <= 6:
            section = _tidy(line).lower()
            continue
        bullet = _BULLET.match(raw)
        if bullet:
            if not _RESOURCE_HEAD.search(section):
                add(bullet.group(1))
            continue
        label = _LABEL_LINE.match(line)
        if label:
            add(f"{label.group(1).strip()}: {label.group(2).strip()}")
            continue
        if len(line) <= 240 and _RULE_SENTENCE.search(line):
            add(line)
    return _clean_items(out)


def extract_requirements(
    description: str | None,
    whop_url: str | None = None,
    *,
    model: str | None = None,
    use_llm: bool = True,
    render: bool = True,
    # Kept deliberately short: this backs an interactive import, and an over-long
    # wait overruns the dev proxy's socket timeout (surfacing as a spurious 500) —
    # the same failure mode the finder hit. Doc fetches (≤6s each) + this stay bounded.
    timeout: int = 10,
) -> dict[str, object]:
    """Read the brief (+ rendered Whop page + any linked docs) → requirement bullets.

    When ``whop_url`` is given and ``render`` is on, the Whop page is loaded in headless
    Chrome so its client-rendered requirements + linked docs are readable (a plain fetch
    can't see them). Returns ``{"requirements", "documents", "links", "source"}`` where
    ``source`` is ``structured|llm|heuristic|none``. Never raises — every failure mode
    degrades gracefully (render off → description only; no model → heuristic).
    """
    desc = (description or "").strip()

    # Render the Whop page so its client-only requirements + linked docs become readable.
    rendered_hrefs: list[str] = []
    if whop_url and render:
        page = whop_render.render_page(whop_url)
        if page:
            desc = (desc + "\n\n" + page["text"]).strip() if desc else page["text"].strip()
            rendered_hrefs = page["hrefs"]

    if not desc and not rendered_hrefs:
        return {"requirements": [], "documents": [], "links": [], "source": "none"}

    # Follow document links — written in the brief AND rendered as anchors on the page —
    # and pull their text into the brief (this is how we reach the real Google Doc rules).
    documents: list[str] = []
    doc_texts: list[str] = []
    for link in _doc_urls(find_doc_links(desc) + rendered_hrefs)[:_MAX_DOCS]:
        text = fetch_document_text(link)
        if text:
            documents.append(link)
            doc_texts.append(f"\n\n--- Linked brief ({link}) ---\n{text}")

    brief = (desc + "".join(doc_texts))[:_MAX_TOTAL_CHARS]

    # 1) Structured parse first — Whop briefs are usually already a formatted rules
    #    list, so this is instant, reliable, and can't hang on a slow local GPU.
    requirements = structured_requirements(brief)
    source = "structured" if requirements else "none"

    # 2) Only reach for the model when the brief is unstructured prose the parser
    #    couldn't crack (and a model is available). Bounded so it never stalls.
    if not requirements and use_llm:
        llm = _llm_requirements(brief, model=model, timeout=timeout)
        if llm:
            requirements, source = llm, "llm"

    # 3) Last resort with no model: keep the rule-shaped lines from the description.
    if not requirements:
        heuristic = _heuristic_requirements(desc)
        if heuristic:
            requirements, source = heuristic, "heuristic"

    # Openable resource links (the Google Doc/brief itself, plus any it references) so
    # the caller can save them as clickable links — from the text AND rendered anchors.
    links = _label_links(_URL_RE.findall(desc) + rendered_hrefs, cap=8)

    logger.info(
        "Requirements extract: %d links -> %d docs -> %d requirements (source=%s, rendered=%s)",
        len(links), len(documents), len(requirements), source, bool(rendered_hrefs),
    )
    return {
        "requirements": requirements,
        "documents": documents,
        "links": links,
        "source": source,
    }
