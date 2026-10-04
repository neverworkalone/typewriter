# Pinned Khaiii (issue #273)

Optional second morphological-analysis Provider for Factory Stage 1. Official Kakao Khaiii
(Apache-2.0, <https://github.com/kakao/khaiii>), tag `v0.4`, revision
`fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a`. Kiwi stays the default; Khaiii runs only when
`--providers kiwi,khaiii` is passed.

## Why a container

The official source does not build on current macOS/CMake 4: its Hunter v0.23.34 bootstrap
(`cmake_minimum_required < 3.5`) and the pinned GTest/fmt packages fail. The image builds the
unmodified `v0.4` source on `ubuntu:20.04` with `gcc-7` (gcc 9 fails on `-Werror=deprecated-copy` in
Hunter's GTest). The container is also the runtime boundary: it runs with `--network none` and no
corpus text leaves the machine.

## Build (once)

```bash
docker build -t typewriter-khaiii:v0.4 docker/khaiii
```

Needs Docker (Colima/Docker Desktop/OrbStack), network access during the build only (Hunter
downloads Boost/Eigen/fmt/spdlog; PyTorch 1.13.1 CPU is needed only to compile the model resources).
Verified on macOS arm64 (Colima `vz`, linux/arm64). It is not asserted that an x86 build yields
bit-identical float output.

## Pins recorded in provider metadata

| Item | Value |
| --- | --- |
| Source tag / revision | `v0.4` / `fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a` (checked in the Dockerfile) |
| Model/resource bundle digest | `7b9838bb286ff0f824fee4b35eaed383fbcb4adeea6e2d8c62bf6beb926ec3bb` (sha256 over sorted file name + file sha256 of `/usr/local/share/khaiii`, computed by the service at run time) |
| Toolchain | `ubuntu:20.04`, `gcc-7`/`g++-7`, `cmake` 3.16, `torch==1.13.1` |
| Runtime | `docker run --rm -i --network none`, read-only mounted `scripts/factory/khaiii_service.py` |

The service reports these in its run metadata; `assertPinnedKhaiii` rejects any drift, which fails
the Stage 1 run closed. `TYPEWRITER_KHAIII_IMAGE` / `TYPEWRITER_DOCKER` override the image tag / CLI.

## Verification and skip protocol

`node --test tests/factory-khaiii-provider.test.mjs` runs synthetic fixtures always and the
**REAL pinned Khaiii v0.4 container smoke** only when the image exists. Where the image is absent the
real test is reported as *skipped* with that reason; no synthetic result may be cited as proof that
the official binary ran. If the image cannot be built, report the obstacle; do not substitute an
unpinned fork.
