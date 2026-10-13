#!/usr/bin/env bash
# Collects only the website files into ./site, ready to drag onto https://app.netlify.com/drop
# (or upload to Cloudflare Pages, GitHub Pages, Vercel). Leaves out the Android project,
# the servers and the README, which don't belong on the website.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf site && mkdir -p site/icons site/sounds site/downloads
cp index.html manifest.webmanifest sw.js config.js ui.js subscription.js premium.js relay.js qrcode.js install.js app.js gmail.js site/
cp icons/*.png site/icons/
cp sounds/*.mp3 site/sounds/
[ -f downloads/nudge-companion.apk ] && cp downloads/nudge-companion.apk site/downloads/ || true
touch site/.nojekyll
echo "Website files are in ./site ($(find site -type f | wc -l) files). Drag that folder to https://app.netlify.com/drop"
