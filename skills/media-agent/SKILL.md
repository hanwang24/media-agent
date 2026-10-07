---
name: media-agent
description: Audio-video work on this machine - probe, transcode, compress, trim, join, extract audio/subtitles/frames/thumbnails, batch-process directories, record the screen, and stream. Use whenever a media file is an input or a media file is the deliverable, and before running any ffmpeg, ffprobe, or MediaInfo command by hand.
---

# Media Agent

This machine has a **portable ffmpeg toolchain** plus an installed plugin that exposes structured
media tools. Prefer the tools: they build argv safely, keep no shell in the loop, honor
cancellation, and return structured facts. Drop to raw ffmpeg only for the gaps listed under
"What the tools do not cover".

## The toolchain

Portable binaries live under the profile tool root, `<dsh-home>/tools/av/bin`. `<dsh-home>` is
`~/.dsh` on both Windows and macOS.

| Tool | File (Windows / macOS) |
|---|---|
| ffmpeg | `ffmpeg.exe` / `ffmpeg` |
| ffprobe | `ffprobe.exe` / `ffprobe` |
| MediaInfo CLI | `mediainfo.exe` / `mediainfo` |

The tools and `av-doctor` resolve these paths themselves on each platform; `DSH_AV_TOOLS` points them
at another install. Install or refresh the toolchain with
`node <skill-directory>/scripts/install-toolchain.mjs`. Do not add a different ffmpeg to PATH and do
not download another build unless the user asks.

**Trap:** the Electron app ships an internal ffmpeg library (for example `ffmpeg.dll` next to the app
executable). That is Chromium's decoder, not a command line, and it cannot transcode anything. The
CLI you want is the one under the tool root above.

Run `node <skill-directory>/scripts/av-doctor.mjs` to print resolved paths, versions, and which
encoders the current build actually has.

## Hardware encoding, per platform

Hardware encoders are opt-in through `hwaccel` and fail loudly when the build or the machine cannot
provide them — never assume a GPU encoder works, and probe the platform first.

| Platform | Accelerators |
|---|---|
| Windows / Linux | `nvenc` (NVIDIA), `qsv` (Intel), `amf` (AMD) |
| macOS | `videotoolbox` |

The `quality` argument keeps one meaning everywhere (0-51, lower is better): on macOS the plugin
translates it onto `videotoolbox`'s inverse `-q:v` scale automatically.

## Tools

| Tool | Use it for |
|---|---|
| `av_probe` | Every codec/container/duration/HDR/channel fact about one file. **Always run this before choosing encode settings.** `includeRaw` adds the verbatim ffprobe + MediaInfo documents. |
| `av_transcode` | One file to one target: codec, `speed`, `quality` or `bitrate`, `scale`, `fps`, trim via `start`/`duration`/`end`, `hwaccel`, `audioCodec`/`audioBitrate`. `videoCodec: "copy"` + `audioCodec: "copy"` remuxes losslessly. `inputFormat`/`outputFormat` force the demuxer/muxer for raw streams. |
| `av_extract` | `what`: `audio`, `subtitle`, `frames`, `thumbnail`, `waveform`. `streamIndex` picks among multiple tracks. |
| `av_clip` | Trim one file. `mode: "copy"` is instant; `mode: "reencode"` is frame-exact. |
| `av_concat` | Join files in order via the concat demuxer. |
| `av_plot` | Render audio figures: Audition-style `waveform`, `spectrogram`, `freq_response`. Decoded with ffmpeg, drawn with the bundled Python (numpy+Pillow). |
| `av_batch` | One operation over a directory: `transcode`, `remux`, `extract-audio`, `thumbnail`, `plot`, `probe`. Skips existing outputs, so a big run is resumable. |

The single `speed` knob (`fastest` … `slowest`) is translated to each encoder's own preset, so you
cannot pass an invalid preset. `hwaccel` is opt-in and fails loudly when the build or the machine
cannot provide it — never assume a GPU encoder works.

### Raw elementary streams

A container-less stream (`.h264`, `.h265`, `.aac`, …) has no container to auto-detect, so name the
demuxer on both the probe and the remux:

1. `av_probe(path="stream.h264", inputFormat="h264")` — ffprobe reads SPS/PPS and reports width,
   height, level, and frame rate.
2. `av_transcode(input="stream.h264", inputFormat="h264", videoCodec="copy", audioCodec="none",
   output="out.mp4")` — remux the raw stream into a container without re-encoding.

A `.ts` transport stream is auto-detected, so a plain `av_probe` and `copy`/`copy` remux already work.

## Workflow

1. **Probe first.** Never infer codecs, resolution, or audio layout from a file name or extension.
2. **Decide settings** from the probed facts. For a lossless container change use `copy`/`copy`; for a
   real re-encode pick codec, `speed`, and a quality target.
3. **One trial file before a directory run.** Use `av_batch` with `limit: 1`, check the result, then
   run the rest.
4. **Verify the output** with `av_probe`: duration, stream count, and codec must match intent. A
   successful exit code is not proof that the encode is right.
5. **Report what changed**: input path, output path, size, elapsed time. Keep the source file.

## Quality guidance

| Goal | Settings |
|---|---|
| Web / general playback | `videoCodec: "h264"`, `quality: 20-23`, `speed: "fast"` |
| Smaller file, same look | `videoCodec: "hevc"`, `quality: 24-28`, `speed: "slow"` |
| Archive / master | keep the source codec; `copy`/`copy` for container changes, or `quality: 16-18` |
| Mobile / messaging | `scale: "1280:-2"`, `quality: 26-28`, `audioBitrate: "96k"` |
| Audio only | `av_extract` with `audioCodec: "copy"` to avoid a generation loss |
| Screenshots / contact sheet | `av_extract` `thumbnail` or `frames` |

Lower `quality` means better. Reach for `bitrate` only when a target bitrate is a hard requirement.

## What the tools do not cover

These are real gaps; use raw ffmpeg or ffprobe directly, with the same argv-array discipline.

- **Screen recording and streaming** run until stopped, so they must not be wrapped in a
  synchronous tool. Run them as a DSH background job (the `bash` or `pwsh` tool with
  `run_in_background: true`) or in the sidebar terminal. See `references/recipes.md`.
- **Filter graphs** — burn-in subtitles, overlays, watermarks, concat *filters*, audio
  normalization, deinterlacing, color/HDR conversion, frame extraction by scene change.
- **Multi-output / segmented work** — HLS/DASH, `tee`, per-scene splitting.

## Long work

`av_batch` with `concurrency` 2-4 is right for many files. A single very long encode is better
started as a background job so the session stays responsive. Record and stream forever, so they are
always background jobs.

Media tools here declare no timeout, so a long encode is never cut off mid-run; interrupting the
call cancels it properly.

## Safety

- **Never write an output over its own input**, and never delete a source file.
- Quote nothing and build no shell strings: with the tools, every value is a separate argv entry.
  In raw ffmpeg calls, pass an argument array and splat it (`& $ff @args` in PowerShell,
  `"$ff" "${args[@]}"` in bash) rather than interpolating into one string.
- Pass `overwrite: false` when the caller wants a guarantee that nothing is replaced.
- Probe a file before transcoding it, so an unexpected HDR, 10-bit, or 7.1 source is a decision
  rather than a surprise.
- Do not re-encode lossy audio just to change a container; copy it.

## Facts worth knowing here

- Software AV1 varies by build — `libaom-av1` (slow) is in the Windows essentials build, while a
  Homebrew full build usually adds `libsvtav1`. Check with `av-doctor` rather than assuming.
- H.264/H.265 output defaults to `yuv420p`, which keeps 10-bit sources playable on ordinary players.
- A `copy` trim starts at the keyframe at or before the requested time. It cannot start exactly at an
  arbitrary frame; use `mode: "reencode"` when the start point must be frame-accurate.
- The concat demuxer needs matching codecs, timebase, resolution, and stream counts. Re-encode parts
  to a common format first when they differ.
- mp4/mov outputs get `+faststart` automatically so they stream and seek well.

## References

- `references/codecs.md` — container/codec/pixel-format choices, hardware encoding, HDR, and audio.
- `references/recipes.md` — command recipes for recording, streaming, HLS, subtitle burn-in, audio
  normalization, thumbnails, and inspection loops.
