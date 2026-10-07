# Codecs, containers, and this build

What to choose and what this specific ffmpeg build can actually do. Verify claims about a file with
`av_probe`, never with the extension.

## Containers

| Container | Use it for | Notes |
|---|---|---|
| `.mp4` | Deliverables, web, phones, editing handoff | H.264/H.265/AV1 + AAC. Add `+faststart` for streaming; the tools do this automatically. |
| `.mkv` | Archiving, many tracks, anything unusual | Holds nearly any codec, many audio and subtitle tracks. Plays in VLC/mpv, not in every browser. |
| `.mov` | Apple workflows, ProRes | Same family as mp4. |
| `.webm` | Open web playback | VP9/AV1 + Opus. No H.264. |
| `.ts` / `.m2ts` | Broadcast, capture, streaming | Tolerates truncation, so it survives a hard kill during capture. |
| `.m4a` / `.mp3` / `.flac` / `.opus` / `.wav` | Audio only | `.wav` is uncompressed and large; `.flac` is lossless and smaller; `.opus` is best at low bitrates. |

Changing container only? Use `videoCodec: "copy"` and `audioCodec: "copy"`. A copy never loses
quality and finishes in seconds.

**Copy compatibility is not automatic.** MP4 cannot hold every codec, and a `copy` into a container
that rejects the stream fails. If a copy fails, either change the target container or re-encode only
the offending stream.

## Video codecs

| Codec | Software encoder here | Strength | Cost |
|---|---|---|---|
| H.264 | `libx264` | Plays everywhere, fast, hardware-friendly | Largest files at equal quality |
| H.265 / HEVC | `libx265` | ~30-50% smaller than H.264 at equal quality | Slower; some browsers and older devices cannot play it |
| AV1 | `libaom-av1` | Best compression | Very slow in software, so it is best avoided interactively |
| VP9 | `libvpx-vp9` | Royalty-free, good for WebM | Slow |

Hardware encoders are available for H.264 and H.265 (and AV1 on some platforms), but a compiled-in
encoder still needs a working GPU and driver, and which families exist depends on the OS:

| Platform | Accelerator | Encoders |
|---|---|---|
| Windows / Linux | `nvenc` (NVIDIA), `qsv` (Intel), `amf` (AMD) | H.264, H.265, AV1 |
| macOS | `videotoolbox` | H.264, H.265 |

Ask for `hwaccel` only when the user wants speed and the machine has the hardware; otherwise stay on
software, which is deterministic. The tools fail loudly when the requested family does not exist on
that platform rather than silently falling back.

`speed` maps to each encoder's native preset internally, so `slowest` becomes `veryslow` for x264,
`p7` for NVENC, and `-cpu-used 0` for libaom; `videotoolbox` has no preset knob, so `speed` is
ignored there. There is no way to pass a preset that the encoder rejects.

The `quality` argument keeps one meaning on every platform (0-51, lower is better). On macOS the
tools translate it onto `videotoolbox`'s inverse `-q:v` (0-100, higher is better) automatically.

## Quality

`quality` is a CRF/CQ-style constant-quality target, roughly 0-51, lower is better:

| Range | Effect |
|---|---|
| 0-15 | Near-lossless; large files |
| 16-20 | Visually lossless for most content; good archival re-encode |
| 21-25 | Good general-purpose delivery |
| 26-30 | Clearly compressed, fine for messaging or small screens |
| 31+ | Visible artifacts; only for tiny previews |

Use `bitrate` instead only when a hard bitrate is required (broadcast, a strict upload cap, or
constant-bitrate streaming). One-pass bitrate control is less efficient than constant quality.

## Pixel format and bit depth

H.264 and H.265 tools here default to `yuv420p`. This matters: a 10-bit source encoded to
`yuv420p10le` produces a file many players and browsers cannot open. Only pass another
`pixelFormat` when the target is known to accept it, or when preserving 10-bit HDR is the point.

## HDR and color

`av_probe` reports `hdr` as `hdr10`, `hdr10+`, `hlg`, `pq`, or `dolby-vision` from the transfer
characteristics and the stream's side data, and reports `rotation` for phone footage that is stored
landscape but displayed portrait.

- Re-encoding HDR to SDR needs an explicit tone-map chain, or the result looks washed out. See
  `recipes.md`.
- Preserving HDR requires a 10-bit pixel format, an HDR-capable encoder, and `-color_primaries`,
  `-color_trc`, and `-colorspace` copied from the source.
- Rotation is display metadata. `-c copy` keeps it; a filter chain can silently drop it, so check
  `rotation` on the output after any filtered re-encode.

## Audio

| Codec | Encoder here | Use it for |
|---|---|---|
| AAC | `aac` | Default for mp4/mov; 128-192 kb/s stereo is transparent for most content |
| Opus | `libopus` | Best quality per bit; WebM, mkv, ogg; 96-128 kb/s is excellent |
| MP3 | `libmp3lame` | Legacy compatibility only |
| FLAC | `flac` | Lossless archival |
| Vorbis | `libvorbis` | Legacy WebM |
| PCM | `pcm_s16le` | Editing interchange (`.wav`), never for delivery |

- **Copy lossy audio to change container.** Re-encoding AAC to AAC loses quality for no benefit.
- Channel layouts: `av_probe` reports `channels` and `channelLayout`. Downmix with `audioChannels: 2`
  only when the target needs stereo.
- Loudness: delivery targets are typically -16 LUFS (podcast/web stereo) or -23 LUFS (broadcast).
  Use the two-pass `loudnorm` recipe; a single-pass gain change does not make levels consistent.
- Sample rate: keep 48 kHz for video work. Resampling to 44.1 kHz gains nothing and can introduce
  artifacts.

## Subtitles

| Format | Type | Where it works |
|---|---|---|
| `srt` / `subrip` | Text | Widely supported; loses positioning and styling |
| `ass` / `ssa` | Text with styling | Full styling and positioning; needs a capable player |
| `mov_text` | Text | The mp4/mov subtitle format |
| `webvtt` | Text | Web players |

Burn-in (`-vf subtitles=`) makes subtitles part of the picture: always visible, but no longer
selectable, searchable, or removable. Prefer a subtitle *track* when the player can be trusted.

## Build differences by platform

The Windows essentials build and a Homebrew full build differ, so check with `av-doctor` rather than
assuming.

On the **Windows essentials build** (installed by default here):

- **No `libsvtav1`.** Software AV1 is `libaom-av1` only, which is much slower.
- No `libaom` speed presets by name; the tools translate `speed` to `-cpu-used`.
- No `ddagrab` (Desktop Duplication). Screen capture uses `gdigrab`, which is CPU-based and fine for
  ordinary desktop capture but not for high-frame-rate game capture.

On **macOS** via `brew install ffmpeg` (the full build):

- Software AV1 usually includes `libsvtav1`, which is much faster than `libaom-av1`.
- Screen capture uses `avfoundation` (see `recipes.md`); there is no `gdigrab` or `dshow`.
- Hardware encoding is `videotoolbox`.

Present and usable on both: `libx264`, `libx265`, `libvpx-vp9`, `libaom-av1`, `libopus`,
`libmp3lame`, `flac`, `libvorbis`, `libwebp`, `aac`; the `hls`, `segment`, `tee`, `rtsp`, `flv`, and
`mpegts` muxers; and the `subtitles`, `ass`, `loudnorm`, `tonemap`, `zscale`, `showwavespic`,
`showspectrumpic`, `palettegen`, and `paletteuse` filters.
