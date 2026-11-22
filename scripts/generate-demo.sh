#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/media"
TMP="$ROOT/.demo-frames"
mkdir -p "$OUT" "$TMP"

encode_clip() {
  local name="$1" duration="$2" bg="$3" accent="$4" kicker="$5" title="$6" subtitle="$7" number="$8" frequency="$9"
  local svg="$TMP/$name.svg" png="$TMP/$name.png"

  cat > "$svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="#07110f"/>
    </linearGradient>
    <radialGradient id="glow" cx="72%" cy="30%" r="55%">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.22"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="960" height="540" fill="url(#bg)"/>
  <rect width="960" height="540" fill="url(#grid)"/>
  <rect width="960" height="540" fill="url(#glow)"/>
  <rect x="0" y="0" width="960" height="7" fill="${accent}"/>
  <g opacity="0.09" fill="none" stroke="${accent}" stroke-width="2">
    <circle cx="790" cy="252" r="150"/><circle cx="790" cy="252" r="110"/><circle cx="790" cy="252" r="70"/>
  </g>
  <g opacity="0.16" fill="${accent}">
    <rect x="752" y="174" width="76" height="156" rx="12"/>
    <rect x="712" y="214" width="156" height="76" rx="12"/>
  </g>
  <text x="748" y="420" font-family="Droid Sans Fallback" font-size="220" font-weight="700" fill="${accent}" fill-opacity="0.07">${number}</text>
  <rect x="64" y="76" width="4" height="70" rx="2" fill="${accent}"/>
  <text x="88" y="101" font-family="Droid Sans Fallback" font-size="20" fill="${accent}">${kicker}</text>
  <text x="86" y="158" font-family="Droid Sans Fallback" font-size="55" font-weight="700" fill="#ffffff">${title}</text>
  <text x="88" y="208" font-family="Droid Sans Fallback" font-size="25" fill="#ffffff" fill-opacity="0.66">${subtitle}</text>
  <path d="M64 416 H896" stroke="#ffffff" stroke-opacity="0.13"/>
  <path d="M64 370 L178 370 L193 344 L211 386 L228 354 L248 370 L462 370" fill="none" stroke="${accent}" stroke-width="2.5" stroke-opacity="0.75"/>
  <text x="64" y="458" font-family="Droid Sans Fallback" font-size="16" letter-spacing="2" fill="#ffffff" fill-opacity="0.42">FIRST AID / BRANCH TRAINING</text>
  <text x="707" y="458" font-family="Droid Sans Fallback" font-size="16" letter-spacing="2" fill="${accent}">LOCAL DEMO ${number}</text>
</svg>
EOF

  magick -background none "$svg" "$png"
  ffmpeg -hide_banner -loglevel error -y \
    -loop 1 -framerate 30 -i "$png" \
    -f lavfi -i "aevalsrc=0.025*sin(2*PI*${frequency}*t)+0.012*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.5*t)):s=48000:c=stereo" \
    -vf "zoompan=z='1.0+0.00010*on':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=960x540:fps=30" \
    -af "afade=t=in:st=0:d=0.25,afade=t=out:st=$(awk "BEGIN{printf \"%.2f\", ${duration}-0.35}"):d=0.35" \
    -t "$duration" -c:v libx264 -preset veryfast -profile:v main -level 3.1 \
    -pix_fmt yuv420p -g 30 -c:a aac -b:a 96k -ar 48000 -ac 2 \
    -movflags frag_keyframe+empty_moov+default_base_moof "$OUT/$name.mp4"
}

encode_clip "scene-intro" 6.4 "#102522" "#E8654F" "急救培训 · 场景 01" "发现伤者" "确认环境安全，靠近并观察意识" "01" 174
encode_clip "branch-check" 5 "#132B23" "#55C98A" "正确处置 · 呼吸评估" "先检查呼吸" "看、听、感觉，判断是否有正常呼吸" "02" 294
encode_clip "branch-move" 4.4 "#2C2117" "#F2B35D" "错误处置 · 随意搬动" "先搬动伤者" "可疑脊柱损伤可能因搬动而加重" "03" 196
encode_clip "scene-continue" 8 "#13232F" "#64B5F6" "急救培训 · 场景 02" "呼救与胸外按压" "拨打 120，立即开始高质量按压" "04" 220
encode_clip "scene-debrief" 4 "#1D1B2C" "#B69CFF" "训练复盘 · 完成" "先判断，再行动" "检查呼吸与循环，避免二次伤害" "05" 262

rm -rf "$TMP"
printf 'Generated demo clips in %s\n' "$OUT"
