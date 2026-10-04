#!/usr/bin/env python3
"""Local MeCab-ko batch analysis service for Factory Stage 1 (issue #281).

Same stdin/stdout shape as scripts/factory/khaiii_service.py. Runs on the host inside the pinned
virtual environment created by scripts/factory/setup-mecab.mjs (PyPI `mecab-ko` 1.0.2 + `mecab-ko-dic`
1.0.0, hash-pinned). The service uses `Tagger.parse` (the single best path) only: on the real
dictionary `parse` and `parseNBest(1)` can pick different equal-cost paths for the same input
(걸어: 걷다 vs 걸다), so N-best is not a dependable, calibrated signal and is never exposed.

Mapping uses the dictionary's own feature columns: for `Inflect`/`Preanalysis` tokens the expression
column (`걷/VV/*+어/EC/*`) is expanded into its morphemes, so irregular and contracted stems come
from the lexicon (돕다, 놀랍다, 걷다) rather than from the surface. A plain VV/VA token is a bound
stem entry; its dictionary form is stem + 다 only when an ending follows in the same path.
"""

from __future__ import annotations

import hashlib
from importlib.metadata import PackageNotFoundError, version as package_version
import json
import os
import re
import sys
import unicodedata

SERVICE_VERSION = "1"
PROPOSAL_CONTRACT = "derivation-root-v1"
MAX_BATCH_SIZE = 500
MAX_TEXT_LENGTH = 2000
POS_BY_TAG = {"NNG": "noun", "VV": "verb", "VA": "adjective", "MAG": "adverb"}
DERIVATIONAL_SUFFIX_POS = {"XSV": "verb", "XSA": "adjective"}
# Content-bearing morphemes this service does not map; a path containing one is only partly
# explained, so the surface is reported unsupported rather than as a clean single proposal.
UNMAPPED_CONTENT_TAGS = {"NNP", "NP", "NR", "MM", "MAJ", "IC", "SL", "SH", "SN", "XPN", "XSN", "VX", "NNB", "UNKNOWN"}
# Only these tags may be skipped as non-content: particles (J*), endings (E*) and punctuation/symbols
# (SF, SE, SS*, SP, SO, SW...). Anything else, e.g. the copulas VCP/VCN, an unmapped content tag or a
# tag this service has never seen, makes the path only partly explained rather than silently dropped.
FUNCTIONAL_TAG = re.compile(r"^(J[A-Z]*|E[A-Z]*|SF|SE|SSO|SSC|SC|SY|SO|SP|SW)$")
HANGUL = re.compile(r"^[가-힣]+$")
EXPRESSION_PART = re.compile(r"^(?P<form>.+)/(?P<tag>[A-Z]+)/(?P<detail>.*)$")


def _package_version(name: str) -> str:
    try:
        return package_version(name)
    except PackageNotFoundError:
        return "unavailable"


def file_digest(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def directory_digest(directory: str) -> str:
    """sha256 over sorted (name, file sha256) of every file in the dictionary directory."""
    outer = hashlib.sha256()
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            outer.update(f"{name}\0{file_digest(path)}\n".encode("utf-8"))
    return outer.hexdigest()


def run_metadata(mecab, dictionary, tagger) -> dict:
    """Identity of the dictionary and runtime that are actually loaded (not what is installed)."""
    package_dir = os.path.dirname(mecab.__file__)
    extension = next(name for name in sorted(os.listdir(package_dir)) if name.startswith("_MeCab") and name.endswith((".so", ".pyd")))
    info = tagger.dictionary_info()
    dicdir = os.path.realpath(dictionary.DICDIR)
    return {
        "service_version": SERVICE_VERSION,
        "proposal_contract": PROPOSAL_CONTRACT,
        "provider": "mecab",
        "python_version": f"{sys.version_info.major}.{sys.version_info.minor}",
        "mecab_ko_version": _package_version("mecab-ko"),
        "mecab_library_version": mecab.VERSION,
        "wrapper_extension_digest": file_digest(os.path.join(package_dir, extension)),
        "library_digest": file_digest(os.path.join(package_dir, ".dylibs", "libmecab.2.dylib")),
        "dictionary_package": "mecab-ko-dic",
        "dictionary_package_version": _package_version("mecab-ko-dic"),
        "dictionary_declared_version": dictionary.VERSION or "undeclared",
        "dictionary_digest": directory_digest(dicdir),
        "dictionary_file_loaded": os.path.relpath(os.path.realpath(info.filename), dicdir),
        "dictionary_charset": info.charset,
        "dictionary_lexicon_size": info.size,
        "user_dictionary": "none" if info.next is None else "present",
        "top_n": 1,
    }


def parse_tokens(output: str):
    """[(surface, features)] from MeCab's default `surface\\tfeatures` lines, or None when malformed."""
    tokens = []
    lines = output.split("\n")
    if lines[-2:] != ["EOS", ""]:
        return None
    for line in lines[:-2]:
        surface, separator, feature_text = line.partition("\t")
        features = feature_text.split(",")
        if not separator or len(features) != 8:
            return None
        tokens.append((unicodedata.normalize("NFC", surface), features))
    return tokens


def morphemes(tokens):
    """Expand tokens into (form, tag) morphemes using the dictionary's own expression column."""
    result = []
    for surface, features in tokens:
        tag, kind, expression = features[0], features[4], features[7]
        if kind in {"Inflect", "Preanalysis"} and expression != "*":
            for part in expression.split("+"):
                match = EXPRESSION_PART.match(part)
                if match is None:
                    return None
                result.append((unicodedata.normalize("NFC", match.group("form")), match.group("tag")))
        elif "+" in tag:
            return None  # a composite tag without a dictionary expansion is not safely separable
        else:
            result.append((surface, tag))
    return result


def proposals(parts):
    """Lemma/POS proposals of one best path, or (None, reason) when it is only partly explained."""
    result = []
    for index, (form, tag) in enumerate(parts):
        previous = parts[index - 1] if index else None
        following = parts[index + 1] if index + 1 < len(parts) else None
        if tag in UNMAPPED_CONTENT_TAGS:
            return None, "unmapped_content_morpheme"
        pos = POS_BY_TAG.get(tag)
        if pos in {"verb", "adjective"}:
            # Stem entries are bound: the dictionary form exists only with a following ending.
            if following is None or not following[1].startswith("E"):
                return None, "stem_without_ending"
            result.append({"lemma": form + "다", "pos": pos, "form": form})
        elif pos is not None:
            result.append({"lemma": form, "pos": pos, "form": form})
        elif tag in DERIVATIONAL_SUFFIX_POS:
            if previous is None or previous[1] not in {"NNG", "XR"}:
                return None, "unmapped_content_morpheme"
            if following is None or not following[1].startswith("E"):
                return None, "stem_without_ending"
            base = previous[0]
            if previous[1] == "NNG" and result and result[-1]["form"] == base:
                result.pop()
            result.append({"lemma": base + form + "다", "pos": DERIVATIONAL_SUFFIX_POS[tag], "form": base + form})
        elif tag == "XR":
            if following is None or following[1] not in DERIVATIONAL_SUFFIX_POS:
                return None, "unmapped_content_morpheme"  # a root is content only through a following XSV/XSA
        elif not FUNCTIONAL_TAG.match(tag):
            return None, "unmapped_content_morpheme"
    if any(not HANGUL.match(item["form"]) for item in result):
        return None, "unmapped_content_morpheme"
    return result, ""


def analyze_one(tagger, text: str) -> dict:
    text = unicodedata.normalize("NFC", text).strip()
    if not text or len(text) > MAX_TEXT_LENGTH:
        return {"status": "unsupported", "reason": "empty_or_too_long", "analyses": []}
    if any(ch.isspace() for ch in text):
        return {"status": "unsupported", "reason": "multi_word_input", "analyses": []}
    try:
        output = tagger.parse(text)
    except Exception as error:  # explicit machine-readable failure, never silent
        return {"status": "error", "reason": type(error).__name__, "analyses": []}
    tokens = parse_tokens(output) if isinstance(output, str) else None
    if tokens is None:
        return {"status": "error", "reason": "malformed_output", "analyses": []}
    if not tokens:
        return {"status": "unsupported", "reason": "no_analysis", "analyses": []}
    parts = morphemes(tokens)
    if parts is None:
        return {"status": "unsupported", "reason": "unexpandable_composite_tag", "analyses": []}
    path, reason = proposals(parts)
    if path is None:
        return {"status": "unsupported", "reason": reason, "analyses": []}
    if not path:
        return {"status": "unsupported", "reason": "no_content_morpheme", "analyses": []}
    return {"status": "ok", "reason": "", "analyses": [path]}


def analyze_batch(tagger, requests: list, metadata: dict) -> dict:
    if len(requests) > MAX_BATCH_SIZE:
        raise ValueError(f"batch exceeds {MAX_BATCH_SIZE} requests")
    results = []
    for request in requests:
        text = str(request.get("text", ""))
        outcome = analyze_one(tagger, text)
        outcome["id"] = str(request.get("id", ""))
        outcome["input_digest"] = hashlib.sha256(unicodedata.normalize("NFC", text).strip().encode("utf-8")).hexdigest()
        results.append(outcome)
    return {"metadata": metadata, "results": results}


def main() -> int:
    try:
        import mecab_ko as mecab
        import mecab_ko_dic as dictionary
        tagger = mecab.Tagger()
        metadata = run_metadata(mecab, dictionary, tagger)
    except Exception as error:  # missing wrapper, missing/corrupt dictionary: fail closed, no text involved
        print(json.dumps({"error": f"mecab_unavailable: {type(error).__name__}"}))
        return 2
    payload = json.load(sys.stdin)
    response = analyze_batch(tagger, payload["requests"], metadata)
    json.dump(response, sys.stdout, ensure_ascii=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
