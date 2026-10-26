#!/bin/sh
# Copies the modules this site shares with the uke app. Edit them there and rerun this; copies edited here are overwritten.
set -eu
src="${UKE:-$HOME/Projects/uke}/public"
dest="$(cd "$(dirname "$0")/.." && pwd)"
for f in \
  analyzer-worklet.js \
  dsp/analyzer.js dsp/chords.js dsp/decompose.js dsp/fft.js dsp/noise.js dsp/notes.js dsp/onset.js dsp/pitch.js \
  game/cards.js game/diagram.js game/score.js game/shapes.js \
  data/chord-chain.json data/uke-fingerings.json
do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$src/$f" "$dest/$f"
done
echo "Copied shared files from $src"
