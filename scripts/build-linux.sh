#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(uname -sm) != "Linux x86_64" ]]; then echo 'Build Linux desktop on Linux x86_64.' >&2; exit 1; fi
image=second-mind:desktop-linux-build
if [[ -n ${SECOND_MIND_BUILD_IMAGE:-} ]]; then image=$SECOND_MIND_BUILD_IMAGE; else docker build --platform linux/amd64 -t "$image" .; fi
stage="$PWD/build/linux"
mkdir -p "$stage"
temporary=$(mktemp -d "$stage/stage.XXXXXXXX")
container=$(docker create "$image")
trap 'docker rm "$container" >/dev/null; rm -rf "$temporary"' EXIT
docker run --rm --network none --user "$(id -u):$(id -g)" -v "$temporary:/export" -v "$PWD/scripts/prepare-linux-runtime.sh:/prepare.sh:ro" --entrypoint sh "$image" /prepare.sh
mkdir -p "$temporary/backend"
for directory in src public node_modules; do docker cp "$container:/app/$directory" "$temporary/backend/"; done
cp -R desktop "$temporary/backend/"
mkdir "$temporary/backend/platform"
cp platform/*.mjs "$temporary/backend/platform/"
cp package.json LICENSE "$temporary/backend/"
node scripts/package-linux.mjs "$temporary"
