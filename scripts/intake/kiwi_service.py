#!/usr/bin/env python3
"""Shared local Kiwi batch analysis service (issue #249).

Reads one JSON request from stdin and writes one JSON response to stdout:
  {"requests": [{"id": str, "text": str}, ...]}
Each request is analyzed in order; one Python process serves a whole batch.
Kiwi output is a proposal, not proof: ambiguity and errors are explicit.
"""

from __future__ import annotations

import hashlib
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import sys
import unicodedata

SERVICE_VERSION = "1"
MAX_BATCH_SIZE = 500
MAX_TEXT_LENGTH = 2000
TOP_N = 3
POS_BY_TAG = {"NNG": "noun", "VV": "verb", "VA": "adjective"}


def base_tag(tag: str) -> str:
    """Kiwi marks irregular/regular variants as VV-I, VA-R, ...; the base tag decides POS."""
    return str(tag).split("-", 1)[0]


def _package_version(name: str) -> str:
    try:
        return package_version(name)
    except PackageNotFoundError:
        return "unavailable"


def run_metadata() -> dict:
    return {
        "service_version": SERVICE_VERSION,
        "kiwipiepy_version": _package_version("kiwipiepy"),
        "kiwipiepy_model_version": _package_version("kiwipiepy_model"),
        "top_n": TOP_N,
    }


DERIVATIONAL_SUFFIX_POS = {"XSV": "verb", "XSA": "adjective"}


def _proposals(tokens) -> list[dict]:
    """Lemma/POS proposals for content morphemes of one analysis path.

    A noun/root followed by a verb/adjective-forming suffix (망각 + 하, 행복 + 하)
    also yields the derived predicate lemma (망각하다), as Typewriter lemmas do.
    """
    result = []
    previous = None
    for token in tokens:
        tag = base_tag(token.tag)
        form = unicodedata.normalize("NFC", str(token.form))
        pos = POS_BY_TAG.get(tag)
        if pos is not None:
            lemma = form + "다" if pos in {"verb", "adjective"} else form
            result.append({"lemma": lemma, "pos": pos, "form": form})
        elif tag in DERIVATIONAL_SUFFIX_POS and previous is not None and previous["tag"] in {"NNG", "XR"}:
            base = result[-1]["form"] if result and result[-1]["lemma"] == previous["form"] else previous["form"]
            result.append({"lemma": base + form + "다", "pos": DERIVATIONAL_SUFFIX_POS[tag], "form": base + form})
        previous = {"tag": tag, "form": form}
    return result


def analyze_one(analyzer, text: str) -> dict:
    text = unicodedata.normalize("NFC", text).strip()
    if not text or len(text) > MAX_TEXT_LENGTH:
        return {"status": "unsupported", "reason": "empty_or_too_long", "analyses": []}
    try:
        paths = analyzer.analyze(text, TOP_N)
    except Exception as error:  # explicit machine-readable failure, never silent
        return {"status": "error", "reason": type(error).__name__, "analyses": []}
    if not paths:
        return {"status": "unsupported", "reason": "no_analysis", "analyses": []}
    analyses = [_proposals(tokens) for tokens, _score in paths]
    if not any(analyses):
        return {"status": "unsupported", "reason": "no_content_morpheme", "analyses": []}
    # Ranked top-N proposal lists; the consumer decides what is ambiguous.
    return {"status": "ok", "reason": "", "analyses": analyses}


def analyze_batch(analyzer, requests: list[dict]) -> dict:
    if len(requests) > MAX_BATCH_SIZE:
        raise ValueError(f"batch exceeds {MAX_BATCH_SIZE} requests")
    results = []
    for request in requests:
        text = str(request.get("text", ""))
        outcome = analyze_one(analyzer, text)
        outcome["id"] = str(request.get("id", ""))
        outcome["input_digest"] = hashlib.sha256(
            unicodedata.normalize("NFC", text).strip().encode("utf-8")
        ).hexdigest()
        results.append(outcome)
    return {"metadata": run_metadata(), "results": results}


def main() -> int:
    try:
        from kiwipiepy import Kiwi
    except ImportError:
        print(json.dumps({"error": "kiwipiepy_not_installed"}))
        return 2
    payload = json.load(sys.stdin)
    response = analyze_batch(Kiwi(), payload["requests"])
    json.dump(response, sys.stdout, ensure_ascii=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
