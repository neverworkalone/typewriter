# Typewriter license overview

Typewriter uses separate licenses for source code, documentation, cleared data,
and brand assets. Third-party components keep their own licenses.

## Source code

Original Typewriter software and configuration are licensed under the Apache
License 2.0 by Never Work Alone, copyright © 2026. This covers `src/`,
`scripts/`, `schema/`, `tests/`, `config/`, `.github/`, `public/manifest.json`,
and original software/configuration files at the repository root, including
`popup.html`, `options.html`, `pack.py`, `pack.sh`, `package.json`,
`pnpm-lock.yaml`, `vite.config.js`, `vitest.config.js`, and `.gitignore`.
Future original software under `web/` and `vite.web.config.js` is also covered.
The complete license text is in [`Apache-2.0.txt`](Apache-2.0.txt).

The code grant excludes canonical and editorial data, documentation, brand
assets, and third-party components. Package-lock records identify upstream
components; they do not change those components' licenses.

## Documentation

Original project documentation is licensed under the Creative Commons Attribution
4.0 International license (CC BY 4.0). This covers docs/, AGENTS.md, REVIEW.md,
README.md, PRIVACY.md, and original explanatory or policy text in LICENSE.md,
DATA-LICENSE.md, and BRAND.md. Embedded canonical data, third-party material and
license texts, trademarks, and brand artwork are excluded and retain their
separate terms. See [`DATA-LICENSE.md`](DATA-LICENSE.md) and [`BRAND.md`](BRAND.md).

## Dictionary data

The **new STDICT-based Typewriter dictionary** (source-derived headwords,
senses, definitions and permitted lexical relationships, plus Typewriter-authored
**말의 결 / 연상** enrichment) will be distributed under
[CC BY-SA 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/).
This applies to the covered dictionary content and its distribution in
`data/canonical/`, generated `dictionary.sqlite`, the extension and web products;
it does **not** relicense separate Typewriter software or third-party runtime
components. The National Institute of Korean Language (NIKL) retains its rights
in the `표준국어대사전` source; Typewriter licenses only the original contributions
for which it has rights. Attributions, exclusions, and the prospective cutover
are described in [`DATA-LICENSE.md`](DATA-LICENSE.md).

Existing grants for previously published independently authored data are not
revoked by adopting the new baseline license.

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
