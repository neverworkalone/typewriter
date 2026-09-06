import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(BASE_DIR, 'public/manifest.json')

with open(MANIFEST_PATH, encoding='utf-8') as manifest_file:
    manifest = json.load(manifest_file)

version = manifest.get('version')
if not isinstance(version, str) or not version.strip():
    raise SystemExit('public/manifest.json must define a non-empty version')

print(f"{os.path.basename(BASE_DIR)}_{version}.zip")
