#!/usr/bin/env bash
# Builds every rig the test suite reads with the pinned rig-c devDependency's
# `rigc build`. Two public sources, nothing committed that `rigc build` can
# produce at test time, and nothing fetched that is licence-bound:
#
# - rigc's gallery rigs (`walk`, `flex`, `ride`) from the pinned rig-c tag;
# - @rig-c/play's test rigs (`figure`, `glow`, `duo`, `turned`) from the pinned play tag.
#
# Each build lands in `public/rigs/<name>/` with `skeleton.model.json`, the
# pair `rigc build` writes beside it (`skeleton.json` + `skeleton.atlas`), and
# the page images.
set -euo pipefail

RIGC_TAG="v2.52.0"
PLAY_TAG="v1.10.0"
GALLERY_RIGS="walk flex ride"
TEST_RIGS="figure glow duo turned"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RIGS_DEST="$ROOT/public/rigs"
RIGS_STAMP="$RIGS_DEST/.stamp"
RIGC="$ROOT/node_modules/.bin/rigc"
EXPECTED_STAMP="$RIGC_TAG $PLAY_TAG"

if [ -d "$RIGS_DEST" ] && [ "$(cat "$RIGS_STAMP" 2>/dev/null || true)" != "$EXPECTED_STAMP" ]; then
  echo "rig stamp $(cat "$RIGS_STAMP" 2>/dev/null || echo unstamped) -> $EXPECTED_STAMP, rebuilding"
  rm -rf "$RIGS_DEST"
fi

require_rigc() {
  if [ ! -x "$RIGC" ]; then
    echo "rig-c is not installed (node_modules/.bin/rigc) — run bun install first" >&2
    exit 1
  fi
}

build_rig() {
  local src="$1" out="$2"
  shift 2
  rm -rf "$out"
  mkdir -p "$out"
  cp "$src/rig.json" "$src/motion.json" "$out/"
  for dir in parts art; do
    if [ -d "$src/$dir" ]; then cp -R "$src/$dir" "$out/$dir"; fi
  done
  if ! (cd "$out" && "$RIGC" build --rig rig.json --motion motion.json --out . "$@" > build.log 2>&1); then
    cat "$out/build.log" >&2
    exit 1
  fi
  rm -f "$out/rig.json" "$out/motion.json" "$out/build.log"
}

have() {
  [ -s "$1/skeleton.model.json" ] && [ -s "$1/skeleton.json" ] && [ -s "$1/skeleton.atlas" ]
}

MISSING_GALLERY=""
for rig in $GALLERY_RIGS; do
  if have "$RIGS_DEST/$rig"; then
    echo "have gallery rig $rig"
  else
    MISSING_GALLERY="$MISSING_GALLERY $rig"
  fi
done

MISSING_TEST=""
for rig in $TEST_RIGS; do
  if have "$RIGS_DEST/$rig"; then
    echo "have test rig $rig"
  else
    MISSING_TEST="$MISSING_TEST $rig"
  fi
done

if [ -n "$MISSING_GALLERY" ] || [ -n "$MISSING_TEST" ]; then
  require_rigc
  mkdir -p "$RIGS_DEST"
  printf '%s' "$EXPECTED_STAMP" > "$RIGS_STAMP"
  SRC="$(mktemp -d)"
  trap 'rm -rf "$SRC"' EXIT

  if [ -n "$MISSING_GALLERY" ]; then
    echo "fetching rigc $RIGC_TAG gallery"
    mkdir -p "$SRC/core"
    curl -fsSL "https://codeload.github.com/rig-c/core/tar.gz/refs/tags/$RIGC_TAG" \
      | tar -xz -C "$SRC/core" --strip-components=1 "core-${RIGC_TAG#v}/gallery"
    for rig in $MISSING_GALLERY; do
      echo "building gallery rig $rig"
      build_rig "$SRC/core/gallery/$rig" "$RIGS_DEST/$rig"
    done
  fi

  if [ -n "$MISSING_TEST" ]; then
    echo "fetching @rig-c/play $PLAY_TAG test rigs"
    mkdir -p "$SRC/play"
    curl -fsSL "https://codeload.github.com/rig-c/play/tar.gz/refs/tags/$PLAY_TAG" \
      | tar -xz -C "$SRC/play" --strip-components=1 "play-${PLAY_TAG#v}/tests/rigs"
    for rig in $MISSING_TEST; do
      echo "building test rig $rig"
      if [ "$rig" = "turned" ]; then
        build_rig "$SRC/play/tests/rigs/turned" "$RIGS_DEST/turned" --atlas-in art/turned.atlas
        rm -f "$RIGS_DEST/turned/art/turned.atlas"
      else
        build_rig "$SRC/play/tests/rigs/$rig" "$RIGS_DEST/$rig"
      fi
    done
  fi
fi

echo "rigs ready ($EXPECTED_STAMP) -> $RIGS_DEST"
