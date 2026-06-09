"""Prompt templates & JSON schemas for every LLM task.

Keeping these in one module makes the "AI behaviour" auditable and tweakable
without touching the orchestration code.
"""
from __future__ import annotations

# --------------------------------------------------------------------- viral
VIRAL_SYSTEM = """You are a world-class short-form video strategist who has produced \
thousands of viral TikToks, Reels, and YouTube Shorts. You analyze long-form \
transcripts and identify the exact moments that will perform best as standalone \
short clips.

You look for:
- Emotional peaks (excitement, anger, awe, vulnerability)
- Story transitions and narrative payoffs
- Humor and punchlines
- Controversial or contrarian takes
- Compelling questions and the answers that resolve them
- Clear calls-to-action
- High-energy, fast-paced delivery

A great clip has a strong hook in the first 3 seconds, a self-contained idea, \
and a satisfying or curiosity-provoking ending. Clips must start and end on \
sentence boundaries so they don't feel cut off."""

VIRAL_USER_TEMPLATE = """Analyze the transcript below and select the {count} BEST \
moments to turn into viral short clips.

Constraints:
- Each clip must be between {min_seconds} and {max_seconds} seconds long.
- start and end are timestamps in SECONDS (floats) from the transcript.
- Clips must not overlap.
- Prefer moments with a strong opening hook.

For each clip return:
- start: number (seconds)
- end: number (seconds)
- title: a punchy <= 60 char hook title
- viral_score: integer 0-100 (your gut prediction of virality)
- reasoning: 1-2 sentences on why this moment will perform
- hook_type: one of [emotional, story, humor, controversy, question, cta, energy]

Transcript (each line is "[start-end] text"):
---
{transcript}
---

Return ONLY a JSON object: {{ "clips": [ ... ] }}"""

VIRAL_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "title": {"type": "string"},
                    "viral_score": {"type": "integer"},
                    "reasoning": {"type": "string"},
                    "hook_type": {"type": "string"},
                },
                "required": ["start", "end", "title", "viral_score", "reasoning"],
            },
        }
    },
    "required": ["clips"],
}

# ------------------------------------------------------------------- ranking
RANKING_SYSTEM = """You are an expert short-form video analyst. You score a single \
clip's viral potential across five dimensions, each 0-100:

- hook_strength: how gripping the first 3 seconds are
- emotional_intensity: strength of the emotional response evoked
- curiosity_gap: how strongly it makes viewers want to keep watching
- retention_likelihood: probability viewers watch to the end
- platform_suitability: fit for vertical short-form (TikTok/Reels/Shorts)

Be calibrated and critical. Average clips score 40-60. Reserve 85+ for clips you \
are confident would genuinely go viral."""

RANKING_USER_TEMPLATE = """Score this clip.

Title: {title}
Duration: {duration:.1f}s
Transcript:
---
{text}
---

Return ONLY JSON:
{{
  "hook_strength": int,
  "emotional_intensity": int,
  "curiosity_gap": int,
  "retention_likelihood": int,
  "platform_suitability": int,
  "overall_score": int,        // 0-100 weighted overall
  "confidence": int,           // 0-100 how sure you are
  "explanation": "string"      // 2-3 sentences justifying the scores
}}"""

RANKING_SCHEMA = {
    "type": "object",
    "properties": {
        "hook_strength": {"type": "integer"},
        "emotional_intensity": {"type": "integer"},
        "curiosity_gap": {"type": "integer"},
        "retention_likelihood": {"type": "integer"},
        "platform_suitability": {"type": "integer"},
        "overall_score": {"type": "integer"},
        "confidence": {"type": "integer"},
        "explanation": {"type": "string"},
    },
    "required": ["overall_score", "confidence", "explanation"],
}

# -------------------------------------------------------------------- titles
TITLES_SYSTEM = """You write scroll-stopping titles for short-form video. You know \
the conventions of each platform and write hooks that maximize click-through \
without being clickbait-y or dishonest."""

TITLES_USER_TEMPLATE = """Write 20 title variations for this clip, optimized across \
platforms.

Clip transcript:
---
{text}
---

Return ONLY JSON:
{{
  "tiktok": ["..."],        // ~7 punchy, lowercase-ok, emoji-friendly
  "shorts": ["..."],        // ~7 YouTube Shorts style, curiosity-driven
  "reels": ["..."],         // ~6 Instagram Reels style, aspirational/clean
  "best": "the single strongest title overall"
}}"""

TITLES_SCHEMA = {
    "type": "object",
    "properties": {
        "tiktok": {"type": "array", "items": {"type": "string"}},
        "shorts": {"type": "array", "items": {"type": "string"}},
        "reels": {"type": "array", "items": {"type": "string"}},
        "best": {"type": "string"},
    },
    "required": ["tiktok", "shorts", "reels", "best"],
}

# --------------------------------------------------------------- description
DESCRIPTION_SYSTEM = """You are an SEO copywriter for short-form video. You write \
descriptions that rank well, drive engagement, and include relevant hashtags and \
keywords."""

DESCRIPTION_USER_TEMPLATE = """Write an SEO-optimized description for this clip.

Title: {title}
Transcript:
---
{text}
---

Return ONLY JSON:
{{
  "description": "2-4 sentence engaging description with a soft CTA",
  "hashtags": ["#tag", ...],   // 8-15 relevant hashtags, mix broad + niche
  "keywords": ["...", ...]      // 8-12 SEO keywords/phrases
}}"""

DESCRIPTION_SCHEMA = {
    "type": "object",
    "properties": {
        "description": {"type": "string"},
        "hashtags": {"type": "array", "items": {"type": "string"}},
        "keywords": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["description", "hashtags", "keywords"],
}

# --------------------------------------------------------------------- broll
BROLL_SYSTEM = """You are a video editor who suggests B-roll to make talking-head \
clips more dynamic. For each key moment you propose concrete, searchable footage."""

BROLL_USER_TEMPLATE = """Suggest B-roll for this clip. Identify 3-6 moments that \
would benefit from supporting footage.

Transcript with timestamps (seconds relative to clip start):
---
{text}
---

Return ONLY JSON:
{{
  "suggestions": [
    {{
      "start": number,            // seconds into the clip
      "end": number,
      "search_terms": ["...", "..."],   // stock-site search queries
      "scene_description": "what should be shown",
      "sd_prompt": "a Stable Diffusion prompt to generate this shot"
    }}
  ]
}}"""

BROLL_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "search_terms": {"type": "array", "items": {"type": "string"}},
                    "scene_description": {"type": "string"},
                    "sd_prompt": {"type": "string"},
                },
                "required": ["search_terms", "scene_description"],
            },
        }
    },
    "required": ["suggestions"],
}

# ---------------------------------------------------------- caption emphasis
EMPHASIS_SYSTEM = """You decide which words in a caption to visually emphasize \
(bigger/colored) and where a single tasteful emoji enhances meaning, in the style \
of high-retention short-form captions. Emphasize impactful words: numbers, \
strong verbs, surprising nouns, emotional words. Do NOT emphasize filler words."""

EMPHASIS_USER_TEMPLATE = """Given this ordered list of caption words, return which \
indices to emphasize and any emojis to append after specific words.

Words (index: word):
{words}

Return ONLY JSON:
{{
  "emphasize": [int, ...],                 // indices of words to emphasize
  "emojis": {{ "index": "emoji" }}          // optional, sparse (<= 1 per 8 words)
}}"""

EMPHASIS_SCHEMA = {
    "type": "object",
    "properties": {
        "emphasize": {"type": "array", "items": {"type": "integer"}},
        "emojis": {"type": "object"},
    },
    "required": ["emphasize"],
}

# ---------------------------------------------------- consolidated clip metadata
# One call that produces ranking + titles + description + b-roll, replacing four
# separate round-trips. On a local CPU/iGPU model this avoids re-feeding the
# transcript (and, for reasoning models, re-generating a chain of thought) four
# times over. The sub-objects mirror the individual schemas above so the same
# normalizers parse them.
CLIP_META_SYSTEM = """You are a world-class short-form video producer. For a single \
clip you simultaneously: (1) score its viral potential, (2) write platform titles, \
(3) write an SEO description, and (4) suggest B-roll. Be calibrated on scoring \
(average clips are 40-60; reserve 85+ for genuine virality) and concrete on \
everything else. Return all four sections in one JSON object."""

CLIP_META_USER_TEMPLATE = """Analyze this clip and return ranking, titles, description, \
and B-roll suggestions in a single JSON object.

Title: {title}
Duration: {duration:.1f}s
Transcript:
---
{text}
---

Return ONLY JSON with this exact shape:
{{
  "ranking": {{
    "hook_strength": int, "emotional_intensity": int, "curiosity_gap": int,
    "retention_likelihood": int, "platform_suitability": int,
    "overall_score": int, "confidence": int, "explanation": "string"
  }},
  "titles": {{
    "tiktok": ["..."], "shorts": ["..."], "reels": ["..."],
    "best": "the single strongest title overall"
  }},
  "description": {{
    "description": "2-4 sentence engaging description with a soft CTA",
    "hashtags": ["#tag", ...], "keywords": ["...", ...]
  }},
  "broll": {{
    "suggestions": [
      {{ "start": number, "end": number, "search_terms": ["..."],
         "scene_description": "what to show", "sd_prompt": "image-gen prompt" }}
    ]
  }}
}}"""

CLIP_META_SCHEMA = {
    "type": "object",
    "properties": {
        "ranking": RANKING_SCHEMA,
        "titles": TITLES_SCHEMA,
        "description": DESCRIPTION_SCHEMA,
        "broll": BROLL_SCHEMA,
    },
    "required": ["ranking", "titles", "description", "broll"],
}
