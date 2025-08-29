#!/usr/bin/env python3
"""
Audio sprite builder for pmgclock
- Reads clips from ./gordon_gow/

    ***********NORMALISATION DID NOT WORK PROPERLY AND WAS REMOVED**************
- Normalizes each clip to target RMS loudness (dBFS), then applies a peak ceiling
    ***********CLIPS WERE NORMALISED USING AUDACITY MACRO INSTEAD**************

- Concatenates to one long sprite
- Writes manifest.json with [start_seconds, duration_seconds]
- Exports WAV (always) and OGG/Opus (if ffmpeg is found)
    *** OPUS EXPORT MANUALLY DISABLED ***

Usage examples:
  python build_sprite.py
  python build_sprite.py --target-dbfs -16 --peak-ceiling -1 --pad-ms 0 --make-csv
  python build_sprite.py --src ./gordon_gow --out clock_sprite

Optional ordering:
  Put a file ./gordon_gow/order.txt with one clip filename per line to force order.
"""

# IMPORTANT --- THIS SCRIPT RELIES ON PYDUB AND FFMPEG
# PYDUB MUST BE INSTALLED --- FFMPEG MUST BE ENV
# SHIFT KEY BROKEN

import argparse
import json
import os
import sys
import csv
import shutil
from pathlib import Path
from typing import List

from pydub import AudioSegment

# ---------- Defaults ----------
DEFAULT_SRC_DIR = "gordon_gow"
DEFAULT_OUT_BASENAME = "clock_sprite"
TARGET_SAMPLE_RATE = 48000
TARGET_CHANNELS = 1
SUPPORTED_EXTS = {".wav", ".aiff", ".aif", ".mp3", ".ogg", ".flac", ".m4a"}

def have_ffmpeg() -> bool:
    return shutil.which("ffmpeg") is not None

def natural_key(s: str):
    import re
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]

def read_order_file(order_path: Path) -> List[str]:
    items = []
    with order_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            items.append(line)
    return items

def collect_sources(src_dir: Path, order_file: Path | None) -> List[Path]:
    files = [p for p in src_dir.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS]
    if not files:
        return []

    if order_file and order_file.exists():
        wanted = read_order_file(order_file)
        by_name = {p.name: p for p in files}
        ordered, missing = [], []
        for name in wanted:
            if name in by_name:
                ordered.append(by_name[name])
            else:
                missing.append(name)
        if missing:
            print("WARNING: Listed in order.txt but not found:", *[f"  - {m}" for m in missing], sep="\n")
        remaining = sorted([p for p in files if p not in ordered], key=lambda p: natural_key(p.name))
        return ordered + remaining

    return sorted(files, key=lambda p: natural_key(p.name))

def load_normalize(seg: AudioSegment) -> AudioSegment:
    if seg.frame_rate != TARGET_SAMPLE_RATE:
        seg = seg.set_frame_rate(TARGET_SAMPLE_RATE)
    if seg.channels != TARGET_CHANNELS:
        seg = seg.set_channels(TARGET_CHANNELS)
    return seg

def match_target_dbfs(seg: AudioSegment, target_dbfs: float) -> AudioSegment:
    # seg.dBFS ~ RMS loudness in dBFS
    change = target_dbfs - seg.dBFS
    return seg.apply_gain(change)

def apply_peak_ceiling(seg: AudioSegment, ceiling_dbfs: float) -> AudioSegment:
    # If max peak is above the ceiling, pull it down so peak == ceiling
    # seg.max_dBFS is <= 0.0 by definition (0 dBFS is full scale)
    peak = seg.max_dBFS  # e.g., -0.3 dBFS
    if peak > ceiling_dbfs:
        seg = seg.apply_gain(ceiling_dbfs - peak)
    return seg

def label_for_path(p: Path) -> str:
    return p.stem

def main():
    parser = argparse.ArgumentParser(description="Build a normalized audio sprite + manifest from gordon_gow clips.")
    parser.add_argument("--src", default=DEFAULT_SRC_DIR, help="Source directory (default: gordon_gow)")
    parser.add_argument("--out", default=DEFAULT_OUT_BASENAME, help="Output base name (default: clock_sprite)")
    parser.add_argument("--pad-ms", type=int, default=0, help="Silence (ms) between clips (default: 0)")
    parser.add_argument("--make-csv", action="store_true", help="Also write manifest.csv")
    parser.add_argument("--target-dbfs", type=float, default=-16.0,
                        help="RMS loudness target in dBFS (default: -16.0; try -14 to -20 for speech)")
    parser.add_argument("--peak-ceiling", type=float, default=-1.0,
                        help="Peak ceiling in dBFS (default: -1.0 to avoid clipping)")
    args = parser.parse_args()

    src_dir = Path(args.src).resolve()
    if not src_dir.exists():
        print(f"ERROR: Source directory not found: {src_dir}")
        sys.exit(1)

    order_file = src_dir / "order.txt"
    sources = collect_sources(src_dir, order_file if order_file.exists() else None)
    if not sources:
        print(f"ERROR: No audio files found in {src_dir} with extensions {sorted(SUPPORTED_EXTS)}")
        sys.exit(1)

    print(f"Found {len(sources)} clips in {src_dir}. ffmpeg detected: {have_ffmpeg()}")
    print(f"Normalizing to mono/{TARGET_SAMPLE_RATE} Hz, target RMS {args.target_dbfs} dBFS, peak ceiling {args.peak_ceiling} dBFS.")
    if args.pad_ms:
        print(f"Padding {args.pad_ms} ms between clips.")

    sprite = AudioSegment.silent(duration=0, frame_rate=TARGET_SAMPLE_RATE)
    manifest = {}
    cursor_frames = 0

    pad = AudioSegment.silent(duration=args.pad_ms, frame_rate=TARGET_SAMPLE_RATE) if args.pad_ms > 0 else None

    for p in sources:
        print(f"  + {p.name}")
        seg = AudioSegment.from_file(p)
        seg = load_normalize(seg)

        # Loudness normalize to target RMS, then enforce peak ceiling
       # seg = match_target_dbfs(seg, args.target_dbfs)
       # seg = apply_peak_ceiling(seg, args.peak_ceiling)

        # Record start/duration with sample precision
        start_seconds = cursor_frames / TARGET_SAMPLE_RATE
        duration_seconds = seg.frame_count() / seg.frame_rate

        # Append audio and advance cursor
        sprite += seg
        cursor_frames += int(seg.frame_count())

        if pad:
            sprite += pad
            cursor_frames += int(pad.frame_count())

        # Manifest duration excludes trailing pad
        manifest[label_for_path(p)] = [round(start_seconds, 6), round(duration_seconds, 6)]

    out_base = Path(args.out)
    wav_path = out_base.with_suffix(".wav")
    ogg_path = out_base.with_suffix(".ogg")
    json_path = Path("manifest.json")
    csv_path = Path("manifest.csv")

    print(f"Exporting WAV -> {wav_path}")
    sprite.export(wav_path, format="wav")  # 16-bit PCM

    #if have_ffmpeg():
    #    try:
    #        print(f"Exporting Opus (OGG) -> {ogg_path}")
    #        sprite.export(ogg_path, format="ogg", codec="libopus")
    #    except Exception as e:
    #        print("WARNING: OGG/Opus export failed (libopus).", e)
    #else:
    #    print("NOTE: ffmpeg not found; skipping OGG/Opus export.")

    print(f"Writing manifest -> {json_path}")
    with json_path.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    if args.make_csv:
        print(f"Writing CSV -> {csv_path}")
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["label", "start_seconds", "duration_seconds"])
            for label, (start, dur) in manifest.items():
                w.writerow([label, start, dur])

    print("Done.")
    print(f"- {wav_path}")
    if ogg_path.exists():
        print(f"- {ogg_path}")
    print(f"- {json_path}")
    if args.make_csv:
        print(f"- {csv_path}")

if __name__ == "__main__":
    main()
