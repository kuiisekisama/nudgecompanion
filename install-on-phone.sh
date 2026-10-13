#!/usr/bin/env sh
# Installs Nudge Companion on an Android phone over USB (Mac and Linux).
cd "$(dirname "$0")" || exit 1

APK="nudge-companion.apk"
[ -f "$APK" ] || APK="downloads/nudge-companion.apk"
[ -f "$APK" ] || { echo "Can't find nudge-companion.apk next to this file."; exit 1; }

if [ ! -x platform-tools/adb ]; then
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    *) OS=linux ;;
  esac
  echo "Downloading Google's Android platform tools (about 7 MB)..."
  curl -fL -o platform-tools.zip "https://dl.google.com/android/repository/platform-tools-latest-$OS.zip" || { echo "Download failed. Check your internet connection."; exit 1; }
  unzip -q -o platform-tools.zip && rm -f platform-tools.zip
fi
[ -x platform-tools/adb ] || { echo "Couldn't set up the installer tool."; exit 1; }

echo
echo "Plug your phone in with a USB cable. USB debugging must be on; tap ALLOW on the phone if it asks."
printf "Press Enter when ready... "
read -r _

platform-tools/adb start-server
platform-tools/adb devices
echo
echo "The list above should show your phone as \"device\". If it says \"unauthorized\", tap Allow on the phone."
echo "Installing..."
if platform-tools/adb install -r "$APK"; then
  echo "Installed. On the phone, open \"Nudge Companion\"."
else
  echo "It did not install. Open READ-ME.txt for the fix for each message."
  exit 1
fi
