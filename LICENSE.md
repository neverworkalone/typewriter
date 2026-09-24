# Typewriter license overview

Typewriter uses separate licenses for source code, documentation, cleared data,
and brand assets. Third-party components keep their own licenses.

## Source code

Original Typewriter software and configuration are licensed under the Apache
License 2.0 by Never Work Alone, copyright © 2026. This covers `src/`,
`scripts/`, `schema/`, `tests/`, `config/`, `.github/`, `public/manifest.json`,
and original software/configuration files at the repository root, including
`popup.html`, `options.html`, `pack.py`, `pack.sh`, `package.json`,
`package-lock.json`, `vite.config.js`, `vitest.config.js`, and `.gitignore`.
Future original software under `web/` and `vite.web.config.js` is also covered.
The complete license text is in [`Apache-2.0.txt`](Apache-2.0.txt).

The code grant excludes canonical and editorial data, documentation, brand
assets, and third-party components. Package-lock records identify upstream
components; they do not change those components' licenses.

## Documentation

Original project documentation is licensed under the Creative Commons Attribution
4.0 International license (CC BY 4.0). This covers docs/, AGENTS.md, REVIEW.md,
README.md, and original explanatory or policy text in LICENSE.md,
DATA-LICENSE.md, and BRAND.md. Embedded canonical data, third-party material and
license texts, trademarks, and brand artwork are excluded and retain their
separate terms. See [`DATA-LICENSE.md`](DATA-LICENSE.md) and [`BRAND.md`](BRAND.md).

## Dictionary data

CC BY 4.0 is the selected license for data records whose redistribution rights
have been individually cleared. The current canonical dataset has unresolved
provenance and is not covered by a redistribution grant until its blockers are
resolved. This boundary also applies to `data/inventory/`, `data/batches/`,
`data/validation/`, generated SQLite databases, and any extension, web, or other
artifact that reproduces uncleared lexical content. See [`DATA-LICENSE.md`](DATA-LICENSE.md).

## Brand assets

The Typewriter and Never Work Alone names, logos, icons, and visual identity are
reserved marks and assets. Use is governed by [`BRAND.md`](BRAND.md); no brand
license is granted by the source-code or data licenses.

## Third-party components

Third-party components are governed by their respective licenses. Generated
extension and web product outputs include the applicable licenses and notices in
[`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt) and
[`Apache-2.0.txt`](Apache-2.0.txt).

GitHub issues, pull requests, review discussions, Actions logs, and other
GitHub-hosted surfaces are not relicensed by this repository notice. Their
publication must pass the applicable repository-release gate. Closing an issue
does not itself grant rights or clear material for publication.
