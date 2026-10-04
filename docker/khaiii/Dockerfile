# Pinned, reproducible build of the official Kakao Khaiii v0.4 (issue #273). Apache-2.0.
FROM ubuntu:20.04
ENV CC=gcc-7 CXX=g++-7 DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends build-essential gcc-7 g++-7 cmake git ca-certificates python3 python3-dev python3-pip curl locales \
    && locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
ARG KHAIII_TAG=v0.4
ARG KHAIII_SHA=fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a
RUN git clone https://github.com/kakao/khaiii.git /khaiii && cd /khaiii && git checkout "$KHAIII_SHA" && test "$(git rev-parse HEAD)" = "$KHAIII_SHA"
WORKDIR /khaiii
RUN pip3 install --no-cache-dir "cython<3" "numpy<2" tqdm torch==1.13.1 --extra-index-url https://download.pytorch.org/whl/cpu
RUN mkdir build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release && make -j4 all && make resource && make install && make package_python
RUN pip3 install /khaiii/build/package_python
ENV KHAIII_SOURCE_TAG=v0.4 KHAIII_SOURCE_SHA=fa5fbd10aeddfe97cd7aa87faee39628e5e9c18a
