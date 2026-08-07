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

# Regression: single-pass audio must preserve legitimate stream start offsets,
# even when the container timeline itself starts at a non-zero timestamp.
run_offset_case() {
  local case_name="$1"
  local video_offset="$2"
  local audio_offset="$3"
  local expected_video_start="$4"
  local expected_audio_start="$5"

  mkdir "$case_name"
  (
    cd "$case_name"
    ffmpeg -hide_banner -loglevel error \
      -itsoffset "$video_offset" -f lavfi -t 6 -i testsrc2=size=320x180:rate=30 \
      -itsoffset "$audio_offset" -f lavfi -t 6 -i sine=frequency=440:sample_rate=48000 \
      -map 0:v:0 -map 1:a:0 \
      -c:v libx264 -preset ultrafast -g 60 -keyint_min 60 -sc_threshold 0 -pix_fmt yuv420p \
      -c:a pcm_s16le input.mkv

    probe_json="$(ffprobe -v error \
      -show_entries format=start_time:stream=codec_type,start_time \
      -of json input.mkv)"
    video_start="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(float(s["start_time"]) for s in d["streams"] if s.get("codec_type")=="video"))' <<<"$probe_json")"
    audio_start="$(python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(float(s["start_time"]) for s in d["streams"] if s.get("codec_type")=="audio"))' <<<"$probe_json")"
    baseline="$(python3 - "$video_start" "$audio_start" <<'PY2'
import sys
print(min(float(sys.argv[1]), float(sys.argv[2])))
PY2
)"
    video_mux_offset="$(python3 - "$video_start" "$baseline" <<'PY2'
import sys
print(max(0.0, float(sys.argv[1]) - float(sys.argv[2])))
PY2
)"
    audio_input_offset="$(python3 - "$baseline" <<'PY2'
import sys
print(-float(sys.argv[1]))
PY2
)"

    ffmpeg -hide_banner -loglevel error -copyts -itsoffset "$audio_input_offset" -i input.mkv \
      -map '0:a:0?' -vn -c:a copy audio.mka
    ffmpeg -hide_banner -loglevel error -i input.mkv \
      -map 0:v:0 -an -c copy -avoid_negative_ts make_zero \
      -f segment -segment_format matroska -segment_time 2 \
      -segment_time_delta 0.05 -reset_timestamps 1 source_%06d.mkv

    : > concat.txt
    for src in source_*.mkv; do
      suffix="${src#source_}"
      ffmpeg -hide_banner -loglevel error -i "$src" \
        -map 0:v:0 -an -map_metadata -1 -map_chapters -1 \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p "encoded_${suffix}"
      printf "file '%s'\n" "encoded_${suffix}" >> concat.txt
    done

    video_offset_args=()
    if python3 - "$video_mux_offset" <<'PY2'
import sys
raise SystemExit(0 if float(sys.argv[1]) > 0 else 1)
PY2
    then
      video_offset_args=(-itsoffset "$video_mux_offset")
    fi

    ffmpeg -hide_banner -loglevel error \
      "${video_offset_args[@]}" -f concat -safe 0 -i concat.txt \
      -i audio.mka -copyts -map 0:v:0 -map '1:a:0?' -c copy output.mkv

    actual_video_start="$(ffprobe -v error -select_streams v:0 -show_entries stream=start_time -of default=nw=1:nk=1 output.mkv)"
    actual_audio_start="$(ffprobe -v error -select_streams a:0 -show_entries stream=start_time -of default=nw=1:nk=1 output.mkv)"
    python3 - "$actual_video_start" "$actual_audio_start" "$expected_video_start" "$expected_audio_start" <<'PY2'
import sys
actual_v, actual_a, expected_v, expected_a = map(float, sys.argv[1:])
for label, actual, expected in (("video", actual_v, expected_v), ("audio", actual_a, expected_a)):
    if abs(actual - expected) > 0.06:
        raise SystemExit(f"{label} start offset mismatch: expected {expected}, got {actual}")
PY2
  )
}

run_offset_case audio_late 5 5.5 0 0.5
run_offset_case video_late 5.5 5 0.5 0
