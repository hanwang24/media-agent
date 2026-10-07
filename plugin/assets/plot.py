#!/usr/bin/env python3
"""Render audio plots (waveform / spectrogram / frequency response) from a WAV file.

Audition-grade static figures using only numpy + Pillow (no scipy, no matplotlib),
so the bundled DSH Python runtime can run it unchanged on Windows and macOS.

The caller decodes the source to a 16-bit WAV with ffmpeg first; this script only
reads PCM and draws. One process reads the WAV once and writes every requested plot.
"""
import argparse
import json
import math
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FMIN = 20.0          # lowest frequency drawn, in Hz
DB_FLOOR = -80.0     # spectrogram colour floor, in dB


def load_wav(path):
    """Read a WAV into a (samples, channels) float64 array and its sample rate."""
    with wave.open(path, "rb") as wf:
        nch = wf.getnchannels()
        sw = wf.getsampwidth()
        rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if sw == 1:
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float64)
        data = (data - 128.0) * 256.0
    elif sw == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
    elif sw == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float64)
    else:
        raise ValueError(f"unsupported sample width {sw} bytes")
    return data.reshape(-1, nch), rate


def load_font(size):
    """A readable font for axis labels, with per-platform fallbacks."""
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def colormap(count=256):
    """A (count, 3) uint8 look-up table interpolated between viridis-like anchors."""
    stops = [(68, 1, 84), (59, 82, 139), (33, 145, 140), (94, 201, 98), (253, 231, 37)]
    stops = np.array(stops, dtype=np.float64)
    xs = np.linspace(0.0, 1.0, len(stops))
    xs_out = np.linspace(0.0, 1.0, count)
    lut = np.stack([np.interp(xs_out, xs, stops[:, c]) for c in range(3)], axis=1)
    return np.clip(lut, 0, 255).astype(np.uint8)


def nice_step(duration, target=6):
    """A human-friendly axis step that yields about `target` ticks."""
    raw = duration / max(1, target)
    for step in (0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600):
        if raw <= step:
            return step
    return 3600


def fmt_time(seconds):
    """Format seconds as m:ss or h:mm:ss."""
    seconds = int(round(seconds))
    if seconds < 3600:
        return f"{seconds // 60}:{seconds % 60:02d}"
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def freq_label(freq):
    return f"{freq / 1000:.0f}k" if freq >= 1000 else str(int(freq))


# --------------------------------------------------------------------------- #
# waveform
# --------------------------------------------------------------------------- #

def render_waveform(data, rate, width, height, separate, path):
    n, nch = data.shape
    peak = max(32768.0, float(np.max(np.abs(data))) or 1.0)
    data = data / peak

    left, right, top, bottom = 64, 16, 16, 44
    pw, ph = width - left - right, height - top - bottom
    image = Image.new("RGB", (width, height), (250, 250, 253))
    draw = ImageDraw.Draw(image)
    font = load_font(13)

    step = nice_step(n / rate)
    for sec in np.arange(0, n / rate, step):
        x = left + int(pw * sec * rate / n)
        draw.line([(x, top), (x, top + ph)], fill=(228, 228, 234))
        draw.text((x + 3, top + ph + 6), fmt_time(sec), fill=(110, 110, 120), font=font)

    if separate and nch > 1:
        band_h = ph // nch
        for ch in range(nch):
            band_top = top + ch * band_h
            draw_wave_band(draw, data[:, ch], n, pw, left, band_top, band_h)
            draw.text((8, band_top + 4), "L" if ch == 0 else "R", fill=(120, 120, 132), font=font)
    else:
        combined = data.mean(axis=1) if nch > 1 else data[:, 0]
        draw_wave_band(draw, combined, n, pw, left, top, ph)

    image.save(path, "PNG", optimize=True)


def draw_wave_band(draw, samples, n, pw, left, band_top, band_h):
    """Draw an Audition-style filled peak envelope for one channel."""
    mid_y = band_top + band_h // 2
    prev = None
    for x in range(pw):
        a = x * n // pw
        b = max(a + 1, (x + 1) * n // pw)
        seg = samples[a:b]
        lo, hi = float(seg.min()), float(seg.max())
        y_hi = mid_y - int((hi + 1.0) / 2 * (band_h - 4))
        y_lo = mid_y - int((lo + 1.0) / 2 * (band_h - 4))
        ymin, ymax = sorted((y_hi, y_lo))
        px = left + x
        draw.line([(px, ymin), (px, ymax)], fill=(40, 96, 220))
        if prev is not None:
            draw.line([(prev, mid_y), (px, mid_y)], fill=(140, 170, 235))
        prev = px
    draw.line([(left, mid_y), (left + pw - 1, mid_y)], fill=(210, 214, 224))


# --------------------------------------------------------------------------- #
# spectrogram
# --------------------------------------------------------------------------- #

def render_spectrogram(data, rate, width, height, path):
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    peak = float(np.max(np.abs(mono))) or 1.0
    mono = mono / peak

    left, right, top, bottom = 72, 90, 16, 44
    pw, ph = width - left - right, height - top - bottom

    nfft = 2048
    hop = nfft // 2
    if len(mono) < nfft:
        mono = np.pad(mono, (0, nfft - len(mono)))
    window = np.hanning(nfft)
    frames = np.lib.stride_tricks.sliding_window_view(mono, nfft)[::hop]
    spec = np.abs(np.fft.rfft(frames * window, axis=1)).T  # (freq_bins, ncols)
    sdb = np.clip(20.0 * np.log10(spec + 1e-12), DB_FLOOR, 0.0)

    freq_bins, ncols = sdb.shape
    fmax = min(rate / 2.0, 22000.0)

    rows = np.arange(ph)
    freqs = fmax * (FMIN / fmax) ** (rows / max(1, ph - 1))
    bin_idx = np.clip((freqs / rate * nfft).astype(np.int64), 0, freq_bins - 1)

    src_cols = (np.arange(pw) * max(1, ncols - 1) // max(1, pw - 1)).astype(np.int64)

    norm = (sdb[bin_idx][:, src_cols] - DB_FLOOR) / -DB_FLOOR  # (ph, pw) in [0,1]
    lut = colormap()
    rgb = lut[np.clip((norm * 255).astype(np.int64), 0, 255)]

    canvas = Image.new("RGB", (width, height), (250, 250, 253))
    canvas.paste(Image.fromarray(rgb, "RGB"), (left, top))
    draw = ImageDraw.Draw(canvas)
    font = load_font(13)

    span = math.log(fmax / FMIN)
    for f in (20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000):
        if FMIN <= f <= fmax:
            y = top + ph - 1 - int((math.log(f) - math.log(FMIN)) / span * (ph - 1))
            draw.line([(left - 4, y), (left, y)], fill=(110, 110, 120))
            draw.text((4, y - 7), freq_label(f), fill=(110, 110, 120), font=font)
    draw.text((left - 60, top + ph // 2 - 8), "Hz", fill=(110, 110, 120), font=font)

    step = nice_step(len(mono) / rate)
    for sec in np.arange(0, len(mono) / rate, step):
        x = left + int(pw * sec * rate / len(mono))
        draw.line([(x, top + ph), (x, top + ph + 4)], fill=(110, 110, 120))
        draw.text((x + 3, top + ph + 8), fmt_time(sec), fill=(110, 110, 120), font=font)

    cb_x = width - right + 20
    cb_top, cb_h, cb_w = top, ph, 14
    for y in range(cb_h):
        v = 1.0 - y / max(1, cb_h - 1)
        draw.line([(cb_x, cb_top + y), (cb_x + cb_w, cb_top + y)], fill=tuple(int(c) for c in lut[int(v * 255)]))
    for dbv in (0, -40, -80):
        y = cb_top + int((dbv - DB_FLOOR) / -DB_FLOOR * (cb_h - 1))
        draw.text((cb_x + cb_w + 4, y - 7), f"{dbv} dB", fill=(110, 110, 120), font=font)

    canvas.save(path, "PNG", optimize=True)


# --------------------------------------------------------------------------- #
# frequency response
# --------------------------------------------------------------------------- #

def render_freq(data, rate, width, height, path):
    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    peak = float(np.max(np.abs(mono))) or 1.0
    mono = mono / peak

    left, right, top, bottom = 72, 16, 16, 44
    pw, ph = width - left - right, height - top - bottom

    nfft = 4096
    if len(mono) < nfft:
        mono = np.pad(mono, (0, nfft - len(mono)))
    window = np.hanning(nfft)
    hop = nfft // 2
    mag = np.zeros(nfft // 2 + 1)
    count = 0
    for start in range(0, len(mono) - nfft + 1, hop):
        mag += np.abs(np.fft.rfft(mono[start:start + nfft] * window))
        count += 1
    if count == 0:
        mag = np.abs(np.fft.rfft(mono[:nfft] * window))
    else:
        mag /= count
    db = np.clip(20.0 * np.log10(mag + 1e-12), -120, 0)

    freqs = np.fft.rfftfreq(nfft, 1.0 / rate)
    fmax = min(rate / 2.0, 22000.0)
    mask = freqs >= FMIN
    f, a = freqs[mask], db[mask]

    image = Image.new("RGB", (width, height), (250, 250, 253))
    draw = ImageDraw.Draw(image)
    font = load_font(13)

    span = math.log(fmax / FMIN)

    def x_of(freq):
        return left + int((math.log(freq) - math.log(FMIN)) / span * (pw - 1))

    def y_of(dbi):
        return top + int((0 - dbi) / 120.0 * (ph - 1))

    for dbv in (0, -20, -40, -60, -80, -100, -120):
        y = y_of(dbv)
        draw.line([(left, y), (left + pw, y)], fill=(228, 228, 234))
        draw.text((4, y - 7), str(dbv), fill=(110, 110, 120), font=font)
    for fg in (20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000):
        if FMIN <= fg <= fmax:
            x = x_of(fg)
            draw.line([(x, top), (x, top + ph)], fill=(228, 228, 234))
            draw.text((x + 3, top + ph + 6), freq_label(fg), fill=(110, 110, 120), font=font)
    draw.text((left - 60, top + ph // 2 - 8), "dB", fill=(110, 110, 120), font=font)

    pts = [(x_of(fr), y_of(am)) for fr, am in zip(f, a) if FMIN <= fr <= fmax]
    if len(pts) >= 2:
        draw.polygon([(left, top + ph)] + pts + [(pts[-1][0], top + ph)], fill=(210, 224, 250))
        for i in range(len(pts) - 1):
            draw.line([pts[i], pts[i + 1]], fill=(40, 96, 220), width=2)

    image.save(path, "PNG", optimize=True)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="16-bit WAV to plot")
    parser.add_argument("--waveform", help="output PNG for the waveform")
    parser.add_argument("--spectrogram", help="output PNG for the spectrogram")
    parser.add_argument("--freq", help="output PNG for the frequency response")
    parser.add_argument("--width", type=int, default=1400)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--channels", choices=["mixed", "separate"], default="mixed")
    args = parser.parse_args()

    if not (args.waveform or args.spectrogram or args.freq):
        parser.error("at least one of --waveform/--spectrogram/--freq is required")

    data, rate = load_wav(args.input)
    outputs = {}

    if args.waveform:
        render_waveform(data, rate, args.width, args.height, args.channels == "separate", args.waveform)
        outputs["waveform"] = args.waveform
    if args.spectrogram:
        render_spectrogram(data, rate, args.width, args.height, args.spectrogram)
        outputs["spectrogram"] = args.spectrogram
    if args.freq:
        render_freq(data, rate, args.width, args.height, args.freq)
        outputs["freq_response"] = args.freq

    print(json.dumps({
        "sampleRate": rate,
        "channels": data.shape[1],
        "durationSeconds": round(data.shape[0] / rate, 3),
        "outputs": outputs,
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
