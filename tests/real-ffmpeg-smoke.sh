#!/usr/bin/env bash
set -euo pipefail

# Validates the same command topology with a native FFmpeg installation.
# The source intentionally has shorter audio than video so the final mux test
# catches accidental use of -shortest, which would truncate valid video frames.
work="${TMPDIR:-/tmp}/ffmpeg-wasm-farm-smoke"
rm -rf "$work"
mkdir -p "$work"
cd "$work"

ffmpeg -hide_banner -loglevel error \
  -f lavfi -t 9 -i testsrc2=size=320x180:rate=30 \
  -f lavfi -t 3 -i sine=frequency=880:sample_rate=48000 \
  -c:v libx264 -preset ultrafast -g 60 -keyint_min 60 -sc_threshold 0 \
  -pix_fmt yuv420p -c:a aac -b:a 96k input.mp4

ffmpeg -hide_banner -loglevel warning -i input.mp4 \
  -map '0:a:0?' -vn -c:a aac -b:a 96k audio.mka

ffmpeg -hide_banner -loglevel warning -i input.mp4 \
  -map '0:v:0?' -an -c copy -avoid_negative_ts make_zero \
  -f segment -segment_format matroska -segment_time 3 \
  -segment_time_delta 0.05 -reset_timestamps 1 source_%06d.mkv

for source in source_*.mkv; do
  index="${source#source_}"
  index="${index%.mkv}"
  ffmpeg -hide_banner -loglevel warning -i "$source" \
    -map '0:v:0?' -an -map_metadata -1 -map_chapters -1 \
    -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
    "encoded_${index}.mkv"
done

: > concat.txt
for encoded in encoded_*.mkv; do printf "file '%s'\n" "$encoded" >> concat.txt; done

ffmpeg -hide_banner -loglevel warning -f concat -safe 0 -i concat.txt \
  -i audio.mka -map '0:v:0?' -map '1:a:0?' -c copy \
  -movflags +faststart output.mp4

duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 output.mp4)"
python - "$duration" <<'PY'
import sys
value = float(sys.argv[1])
if not 8.9 <= value <= 9.1:
    raise SystemExit(f"expected full 9-second video, got {value:.3f} seconds")
PY

ffprobe -v error -show_entries format=duration \
  -show_entries stream=index,codec_name,codec_type,duration -of json output.mp4
