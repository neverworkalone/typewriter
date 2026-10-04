#!/usr/bin/env python3
"""Local Khaiii batch analysis service for Factory Stage 1 (issue #273).

Same stdin/stdout shape as scripts/intake/kiwi_service.py. Runs either inside the pinned container
(docker/khaiii/Dockerfile, `docker` runtime, no network) or on the host against the verified
`genonfire/khaiii` macOS arm64 release (`native` runtime; KHAIII_NATIVE_ROOT). The normalization
below is shared by both runtimes. Khaiii returns exactly one best path and no score,
so every result carries a single analysis; N-best, ranking and `derived_from*` are never invented.
A noun/root directly followed by XSV/XSA inside the one path is reported as that one derived
predicate (the whole surface explained by one proposal); it is not linked to a separate root.
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
NATIVE_ROOT = os.environ.get("KHAIII_NATIVE_ROOT", "")
RUNTIME = "native" if NATIVE_ROOT else "docker"
RESOURCE_DIR = os.path.join(NATIVE_ROOT, "share", "khaiii") if NATIVE_ROOT else os.environ.get("KHAIII_RESOURCE_DIR", "/usr/local/share/khaiii")
LIB_PATH = os.path.join(NATIVE_ROOT, "lib", "libkhaiii.dylib") if NATIVE_ROOT else ""
POS_BY_TAG = {"NNG": "noun", "VV": "verb", "VA": "adjective", "MAG": "adverb"}
DERIVATIONAL_SUFFIX_POS = {"XSV": "verb", "XSA": "adjective"}
# Content-bearing morphemes this service does not map; a path containing one is only partly
# explained, so the surface is reported unsupported rather than as a clean single proposal.
UNMAPPED_CONTENT_TAGS = {"NNP", "NP", "NR", "MM", "MAJ", "IC", "SL", "SH", "SN", "XPN", "XSN", "XR", "VX", "NNB"}
HANGUL = re.compile(r"^[가-힣]+$")


def _package_version(name: str) -> str:
    try:
        return package_version(name)
    except PackageNotFoundError:
        return "unavailable"


def _native_version() -> str:
    from khaiii import KhaiiiApi
    return KhaiiiApi(lib_path=LIB_PATH, rsc_dir=RESOURCE_DIR).version()


def resource_digest(directory: str = RESOURCE_DIR) -> str:
    """sha256 over sorted (name, file sha256) of the compiled model/resource bundle."""
    outer = hashlib.sha256()
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        inner = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                inner.update(chunk)
        outer.update(f"{name}\0{inner.hexdigest()}\n".encode("utf-8"))
    return outer.hexdigest()


def _release_provenance() -> dict:
    if not NATIVE_ROOT:
        return {}
    with open(os.path.join(NATIVE_ROOT, "PROVENANCE.json"), encoding="utf-8") as handle:
        return json.load(handle)


def _source() -> tuple:
    if NATIVE_ROOT:
        upstream = _release_provenance().get("upstream", {})
        return upstream.get("tag", "unavailable"), upstream.get("commit", "unavailable")
    return os.environ.get("KHAIII_SOURCE_TAG", "unavailable"), os.environ.get("KHAIII_SOURCE_SHA", "unavailable")


def file_digest(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_metadata() -> dict:
    return {
        "runtime": RUNTIME,
        "library_digest": file_digest(LIB_PATH) if LIB_PATH else "container",
        "service_version": SERVICE_VERSION,
        "proposal_contract": PROPOSAL_CONTRACT,
        "provider": "khaiii",
        "khaiii_version": _package_version("khaiii") if RUNTIME == "docker" else _native_version(),
        "khaiii_source_tag": _source()[0],
        "khaiii_source_sha": _source()[1],
        "release_fork_commit": _release_provenance().get("fork_commit", "container"),
        "release_provenance_digest": file_digest(os.path.join(NATIVE_ROOT, "PROVENANCE.json")) if NATIVE_ROOT else "container",
        "resource_digest": resource_digest(),
        "top_n": 1,
    }


def proposals(morphs) -> list[dict]:
    """Lemma/POS proposals of one Khaiii path, or None when the path is only partly explained."""
    result = []
    previous = None
    for lex, tag in morphs:
        form = unicodedata.normalize("NFC", lex)
        if tag in UNMAPPED_CONTENT_TAGS and not (tag == "XR"):
            return None
        pos = POS_BY_TAG.get(tag)
        if pos is not None:
            result.append({"lemma": form + "다" if pos in {"verb", "adjective"} else form, "pos": pos, "form": form})
        elif tag in DERIVATIONAL_SUFFIX_POS and previous is not None and previous[1] in {"NNG", "XR"}:
            base = previous[0]
            if previous[1] == "NNG" and result and result[-1]["form"] == base:
                result.pop()
            result.append({"lemma": base + form + "다", "pos": DERIVATIONAL_SUFFIX_POS[tag], "form": base + form})
        elif tag == "XR":
            pass  # a root is content only through a following XSV/XSA
        previous = (form, tag)
    if any(not HANGUL.match(item["form"]) for item in result):
        return None
    return result


def analyze_one(api, text: str) -> dict:
    text = unicodedata.normalize("NFC", text).strip()
    if not text or len(text) > MAX_TEXT_LENGTH:
        return {"status": "unsupported", "reason": "empty_or_too_long", "analyses": []}
    if any(ch.isspace() for ch in text):
        return {"status": "unsupported", "reason": "multi_word_input", "analyses": []}
    try:
        words = api.analyze(text)
    except Exception as error:  # explicit machine-readable failure, never silent
        return {"status": "error", "reason": type(error).__name__, "analyses": []}
    if len(words) != 1:
        return {"status": "unsupported", "reason": "no_analysis", "analyses": []}
    path = proposals([(morph.lex, morph.tag) for morph in words[0].morphs])
    if path is None:
        return {"status": "unsupported", "reason": "unmapped_content_morpheme", "analyses": []}
    if not path:
        return {"status": "unsupported", "reason": "no_content_morpheme", "analyses": []}
    return {"status": "ok", "reason": "", "analyses": [path]}


def analyze_batch(api, requests: list[dict]) -> dict:
    if len(requests) > MAX_BATCH_SIZE:
        raise ValueError(f"batch exceeds {MAX_BATCH_SIZE} requests")
    results = []
    for request in requests:
        text = str(request.get("text", ""))
        outcome = analyze_one(api, text)
        outcome["id"] = str(request.get("id", ""))
        outcome["input_digest"] = hashlib.sha256(unicodedata.normalize("NFC", text).strip().encode("utf-8")).hexdigest()
        results.append(outcome)
    return {"metadata": run_metadata(), "results": results}


def main() -> int:
    if NATIVE_ROOT:
        sys.path.insert(0, os.path.join(NATIVE_ROOT, "python"))
    try:
        from khaiii import KhaiiiApi
    except ImportError:
        print(json.dumps({"error": "khaiii_not_installed"}))
        return 2
    payload = json.load(sys.stdin)
    api = KhaiiiApi(lib_path=LIB_PATH, rsc_dir=RESOURCE_DIR) if NATIVE_ROOT else KhaiiiApi()
    response = analyze_batch(api, payload["requests"])
    json.dump(response, sys.stdout, ensure_ascii=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
