#!/bin/sh
# Makes the probe's test files in media/ (with FFmpeg and libmp3lame), and media/index.json with each one's length.
# Each file has its own sound, so it is clear in the car which one plays:
#   probe.mp3   30 s, 440 Hz beeps, ID3v2.3 tags (title, artist, album) and a front cover (cover.png)
#   probe.m4a   30 s, 554 Hz beeps, AAC-LC, iTunes tags and the cover
#   probe.aac   30 s, 659 Hz beeps, AAC-LC in ADTS (no tags: ADTS has none)
#   live.mp3    60 s, 880 Hz double beeps, no tags: the growing file, the pipe and the http streams
#   tone48.wav  2 s, 523 Hz, 48 kHz stereo: the tone on source 287 (aplay)
#   cover.png   300x300: the MP3's and M4A's cover, and the albumArt written to CarLifeMp
set -e
cd "$(dirname "$0")/media"
F="ffmpeg -hide_banner -loglevel error -y"
beeps() { echo "aevalsrc=0.3*sin(2*PI*$1*t)*lt(mod(t\,1)\,0.5):s=44100:d=$2"; }
$F -f lavfi -i "color=c=0x1b5fa8:s=300x300,drawbox=x=40:y=40:w=220:h=220:color=0xf0b020:t=fill,drawbox=x=100:y=100:w=100:h=100:color=0x1b5fa8:t=fill" -frames:v 1 cover.png
$F -f lavfi -i "$(beeps 440 30)" -i cover.png -map 0:a -map 1:v -ac 2 -c:a libmp3lame -b:a 128k -c:v png -disposition:v attached_pic \
   -id3v2_version 3 -metadata title="Probe MP3" -metadata artist="Media Probe" -metadata album="Probe Album" -metadata:s:v comment="Cover (front)" probe.mp3
$F -f lavfi -i "$(beeps 554 30)" -i cover.png -map 0:a -map 1:v -ac 2 -c:a aac -b:a 128k -c:v png -disposition:v attached_pic \
   -metadata title="Probe M4A" -metadata artist="Media Probe" -metadata album="Probe Album" -movflags +faststart probe.m4a
$F -f lavfi -i "$(beeps 659 30)" -ac 2 -c:a aac -b:a 128k -f adts probe.aac
$F -f lavfi -i "aevalsrc=0.3*sin(2*PI*880*t)*lt(mod(t\,1)\,0.15)+0.3*sin(2*PI*880*t)*gte(mod(t\,1)\,0.3)*lt(mod(t\,1)\,0.45):s=44100:d=60" -ac 2 -c:a libmp3lame -b:a 128k -write_xing 0 live.mp3
$F -f lavfi -i "sine=f=523:r=48000:d=2" -ac 2 -c:a pcm_s16le -af volume=0.3 tone48.wav
node -e '
const fs = require("fs"), cp = require("child_process");
const out = {};
for (const f of ["probe.mp3", "probe.m4a", "probe.aac", "live.mp3", "tone48.wav", "cover.png"]) {
    const d = f.endsWith(".png") ? 0 : Number(cp.execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim());
    out[f] = { bytes: fs.statSync(f).size, seconds: Math.round(d * 100) / 100 };
}
fs.writeFileSync("index.json", JSON.stringify(out, null, 1) + "\n");
console.log(out);'
