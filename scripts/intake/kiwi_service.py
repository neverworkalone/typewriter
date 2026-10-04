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
# Version of the proposal semantics. v1: derived predicates carry `derived_from`/`derived_from_index`.
# Kept separate from SERVICE_VERSION so stored hand-offs (service_version "1") stay verifiable.
PROPOSAL_CONTRACT = "derivation-root-v1"
POS_BY_TAG = {"NNG": "noun", "VV": "verb", "VA": "adjective", "MAG": "adverb"}
PINNED_VERSIONS = {"kiwipiepy": "0.24.0", "kiwipiepy_model": "0.24.0"}


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
        "proposal_contract": PROPOSAL_CONTRACT,
        "pinned": dict(PINNED_VERSIONS),
    }


def verify_pinned_versions() -> None:
    for name, expected in PINNED_VERSIONS.items():
        actual = _package_version(name)
        if actual != expected:
            raise RuntimeError(f"{name} {actual} does not match pinned {expected}")


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
            root_index = len(result) - 1 if previous["tag"] == "NNG" and result and result[-1]["lemma"] == previous["form"] else None
            base = result[root_index]["form"] if root_index is not None else previous["form"]
            # `derived_from` / `derived_from_index` keep the analyzer's own root→suffix link: the root
            # text and the position of its noun proposal in this path (None for a non-noun XR root).
            result.append({
                "lemma": base + form + "다",
                "pos": DERIVATIONAL_SUFFIX_POS[tag],
                "form": base + form,
                "derived_from": base,
                "derived_from_index": root_index,
            })
        previous = {"tag": tag, "form": form}
    return result


STABILITY_ATTEMPTS = 3


def _analyses_once(analyzer, text: str):
    paths = analyzer.analyze(text, TOP_N)
    return [_proposals(tokens) for tokens, _score in paths]


def _stable_analyses(analyzer, text: str):
    """Return the analyses only when two runs agree (None if they never do).

    kiwipiepy 0.24.0 occasionally returns a corrupted token form (U+FFFD or
    stray bytes) for a sound input. A corrupted or run-dependent result must not
    become a hand-off, so each input is analyzed until two runs agree.
    """
    seen = []
    for _ in range(STABILITY_ATTEMPTS):
        analyses = _analyses_once(analyzer, text)
        if any("\ufffd" in item["form"] or "\ufffd" in item["lemma"] for path in analyses for item in path):
            seen.append(None)
            continue
        if analyses in seen:
            return analyses
        seen.append(analyses)
    return None


def analyze_one(analyzer, text: str) -> dict:
    text = unicodedata.normalize("NFC", text).strip()
    if not text or len(text) > MAX_TEXT_LENGTH:
        return {"status": "unsupported", "reason": "empty_or_too_long", "analyses": []}
    try:
        analyses = _stable_analyses(analyzer, text)
    except Exception as error:  # explicit machine-readable failure, never silent
        return {"status": "error", "reason": type(error).__name__, "analyses": []}
    if analyses is None:
        return {"status": "error", "reason": "unstable_output", "analyses": []}
    if not analyses:
        return {"status": "unsupported", "reason": "no_analysis", "analyses": []}
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
    try:
        verify_pinned_versions()
    except RuntimeError as error:
        print(json.dumps({"error": f"version_mismatch: {error}"}))
        return 3
    payload = json.load(sys.stdin)
    response = analyze_batch(Kiwi(), payload["requests"])
    json.dump(response, sys.stdout, ensure_ascii=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
