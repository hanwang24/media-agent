# Command recipes

Work the `av_*` tools deliberately do not wrap, because it either runs forever, needs a filter
graph, or produces many outputs. Every command below was checked against the portable build; where a
platform differs (screen capture especially), both forms are given.

## Shells

The tools resolve the binaries themselves; these recipes run them directly, so set the paths once.
`<dsh-home>` is `~/.dsh` on both platforms.

PowerShell (Windows):

```powershell
$ff = "$HOME\.dsh\tools\av\bin\ffmpeg.exe"
$fp = "$HOME\.dsh\tools\av\bin\ffprobe.exe"
$mi = "$HOME\.dsh\tools\av\bin\mediainfo.exe"
```

Bash (macOS):

```bash
ff="$HOME/.dsh/tools/av/bin/ffmpeg"
fp="$HOME/.dsh/tools/av/bin/ffprobe"
mi="$HOME/.dsh/tools/av/bin/mediainfo"
```

Pass arguments as an array and splat them, which keeps one value per argv entry so a path
containing a space, `&`, or `$` cannot change the command:

```powershell
# PowerShell
$args = @('-hide_banner','-nostdin','-y','-i',$in,'-c:v','libx264','-crf','23',$out)
& $ff @args
```

```bash
# bash
args=(-hide_banner -nostdin -y -i "$in" -c:v libx264 -crf 23 "$out")
"$ff" "${args[@]}"
```

Always include `-nostdin`. Without it ffmpeg consumes the terminal's input and can appear to hang.

## Screen recording

Recording never ends on its own, so it must run as a **DSH background job** (`pwsh`/`bash` with
`run_in_background: true`) or in the sidebar terminal, never as a blocking tool call.

### Windows (gdigrab)

```powershell
# Primary display, 30 fps, H.264. Stop with job_kill, which finalizes the file.
& $ff -hide_banner -f gdigrab -framerate 30 -i desktop `
      -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart out.mp4

# One window, by its exact title
& $ff -hide_banner -f gdigrab -framerate 30 -i title="Notepad" -c:v libx264 -crf 23 out.mp4

# A bounded region: -offset_x/-offset_y/-video_size
& $ff -hide_banner -f gdigrab -framerate 30 -offset_x 100 -offset_y 100 -video_size 1280x720 `
      -i desktop -t 30 -c:v libx264 -crf 21 out.mp4

# List DirectShow audio devices, then use the printed name verbatim
& $ff -hide_banner -list_devices true -f dshow -i dummy
& $ff -hide_banner -f gdigrab -framerate 30 -i desktop `
      -f dshow -i audio="Stereo Mix (Realtek Audio)" `
      -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k out.mp4
```

### macOS (avfoundation)

```bash
# List capture devices; screen is usually index 1, a mic is 0
"$ff" -hide_banner -f avfoundation -list_devices true -i ""

# Screen only (device 1, no audio)
"$ff" -hide_banner -f avfoundation -framerate 30 -i "1:none" \
      -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart out.mp4

# Screen plus microphone (screen 1, audio 0) — adjust indices from the device list
"$ff" -hide_banner -f avfoundation -framerate 30 -video_device_index 1 -i "1:0" \
      -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 160k out.mp4
```

On macOS, `avfoundation` screen capture may need the app to have Screen Recording permission. If the
device list shows no screen, grant the permission and retry.

Killing a recording mid-write can leave an unplayable container. For a recording that must survive a
hard kill, write to `-f mpegts out.ts` or use `-f segment`, both of which tolerate truncation.

## Streaming

Also a background job. Nothing here returns a file, so there is nothing to verify afterwards except
the encoder's stderr.

```bash
# RTMP to a service ingest
"$ff" -hide_banner -re -i "$in" -c:v libx264 -preset veryfast -b:v 4500k -maxrate 4500k -bufsize 9000k \
      -pix_fmt yuv420p -g 60 -c:a aac -b:a 160k -ar 48000 -f flv rtmp://host/app/key

# RTSP (Windows live screen; use the avfoundation input on macOS)
"$ff" -hide_banner -f gdigrab -framerate 30 -i desktop -c:v libx264 -preset veryfast -tune zerolatency \
      -b:v 3000k -f rtsp rtsp://host:8554/live

# SRT
"$ff" -hide_banner -re -i "$in" -c:v libx264 -preset veryfast -b:v 3000k -c:a aac -f mpegts "srt://host:9000"
```

`-re` paces the input at real time; without it a file streams as fast as it encodes. Keep `-g` at
twice the frame rate so a player can join the stream quickly.

## HLS packaging

```bash
"$ff" -hide_banner -i "$in" -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k \
      -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_filename "seg%03d.ts" index.m3u8
```

## Subtitles

The `subtitles` and `ass` filters are available on both platforms, so burn-in works. Only the
Windows path escaping differs.

macOS / bash (plain path):

```bash
"$ff" -hide_banner -i "$in" -vf "subtitles='/path/to/sub.srt'" -c:v libx264 -crf 22 -c:a copy out.mp4
```

Windows / PowerShell (escape the drive colon, use forward slashes):

```powershell
$sub = "C\:/media/sub.srt"
& $ff -hide_banner -i $in -vf "subtitles='$sub'" -c:v libx264 -crf 22 -c:a copy out.mp4
```

Add a subtitle track without re-encoding the video (both platforms, same command):

```bash
"$ff" -hide_banner -i "$in" -i sub.srt -map 0 -map 1 -c copy -c:s mov_text out.mp4
```

Use `av_extract` with `what: "subtitle"` to pull a track out; it handles the stream mapping.

## Audio

```bash
# EBU R128 two-pass loudness normalization, the correct way to make levels consistent
"$ff" -hide_banner -i "$in" -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
# read the measured values from stderr, then apply them
"$ff" -hide_banner -i "$in" -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=..:measured_TP=..:measured_LRA=..:measured_thresh=..:offset=.." \
      -c:v copy -c:a aac -b:a 192k out.mp4

# Simple peak normalization when consistency matters less
"$ff" -hide_banner -i "$in" -af "dynaudnorm" -c:v copy -c:a aac out.mp4

# Change tempo without changing pitch
"$ff" -hide_banner -i "$in" -filter:a "atempo=1.5" -c:v copy out.mp4

# Measure loudness and true peak for a report
"$ff" -hide_banner -i "$in" -filter:a ebur128 -f null -
```

## Finding cut points

```bash
# Report silence so a cut lands in a gap, not mid-word
"$ff" -hide_banner -i "$in" -af "silencedetect=noise=-35dB:d=0.6" -f null -

# Report scene changes so a split lands on a visual boundary
"$ff" -hide_banner -i "$in" -vf "select='gt(scene,0.4)',showinfo" -f null -
```

Then cut with `av_clip` (`mode: "copy"` when the boundary is already a keyframe) or split the file
with `-f segment -segment_times`.

## Contact sheet and images

```bash
# A tiled thumbnail grid, one frame every 30 s
"$ff" -hide_banner -i "$in" -vf "fps=1/30,scale=320:-2,tile=5x4" -frames:v 1 sheet.jpg

# A single frame at a timestamp
"$ff" -hide_banner -ss 00:01:30 -i "$in" -frames:v 1 -vf "scale=1280:-2" shot.png

# A spectrogram image
"$ff" -hide_banner -i "$in" -lavfi "showspectrumpic=s=1200x600" spec.png

# An animated GIF: build a palette first, or the colours will band badly
"$ff" -hide_banner -ss 5 -t 3 -i "$in" -vf "fps=12,scale=480:-1:flags=lanczos,palettegen" palette.png
"$ff" -hide_banner -ss 5 -t 3 -i "$in" -i palette.png \
      -lavfi "fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" out.gif
```

## HDR to SDR

Only needed when an HDR source must play correctly on an SDR display. Check `av_probe` first: a
`hdr` value of `hdr10`, `hdr10+`, `hlg`, or `dolby-vision` means a naive re-encode will look washed
out.

```bash
"$ff" -hide_banner -i "$in" -vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" \
      -c:v libx264 -crf 20 -c:a copy out-sdr.mp4
```

Dolby Vision needs its own handling and is not fully supported by this pipeline; report that limit
rather than silently producing a wrong-looking file.

## Inspection loops

`av_batch` with `operation: "probe"` is the built-in way to survey a directory. For a CSV that
another tool will read, use ffprobe directly.

Bash (macOS):

```bash
for f in *.mp4; do
  info=$("$fp" -v error -print_format json -show_format -show_streams "$f")
  echo "$info" | python3 -c 'import sys,json;d=json.load(sys.stdin);s=d["streams"];v=[x for x in s if x.get("codec_type")=="video"][0];print(f"{d[\"format\"][\"duration\"]}\t{v.get(\"width\")}\t{v.get(\"height\")}\t{v.get(\"codec_name\")}")' | awk -v file="$f" '{print file"\t"$0}'
done > report.tsv
```

PowerShell (Windows):

```powershell
Get-ChildItem -File -Filter *.mp4 | ForEach-Object {
  $p = & $fp -v error -print_format json -show_format -show_streams $_.FullName | ConvertFrom-Json
  $v = $p.streams | Where-Object codec_type -eq 'video' | Select-Object -First 1
  [pscustomobject]@{
    File = $_.Name; Seconds = [math]::Round([double]$p.format.duration,2)
    Width = $v.width; Height = $v.height; VCodec = $v.codec_name
    MB = [math]::Round($_.Length/1MB,1)
  }
} | Export-Csv -NoTypeInformation -Encoding utf8 report.csv
```

MediaInfo is better than ffprobe for some derived facts (writing library, HDR metadata, channel
layout). For a whole folder in one call, both platforms:

```bash
"$mi" --Output=JSON *.mkv
```

## Verifying a result

```bash
# Streams, duration, and container of the output
"$fp" -v error -show_entries format=format_name,duration,size,bit_rate -show_entries stream=index,codec_type,codec_name,width,height,sample_rate,channels -of default=noprint_wrappers=1 "$out"

# Decode every frame to prove the file is not corrupt (slow but conclusive)
"$ff" -v error -i "$out" -f null -

# Compare two files' stream layout before and after
"$mi" --Output=JSON "$in"
"$mi" --Output=JSON "$out"
```

`av_probe` covers the first and third of these; use `-f null -` when a full decode check is warranted.
