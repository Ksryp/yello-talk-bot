#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_sdk_root="${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT to a locally installed Android SDK}"
build_tools_version="${ANDROID_BUILD_TOOLS_VERSION:?Set ANDROID_BUILD_TOOLS_VERSION}"
platform_version="${ANDROID_PLATFORM_VERSION:-android-30}"
bundled_gme_sdk="$script_dir/../vendor-sdk/android/libs"
gme_android_jar="${GME_ANDROID_JAR:-$bundled_gme_sdk/gmesdk.jar}"
gme_android_jni_dir="${GME_ANDROID_JNI_DIR:-$bundled_gme_sdk/x86_64}"
signing_keystore="${GME_SIGNING_KEYSTORE:?Set GME_SIGNING_KEYSTORE to a local signing keystore}"
signing_alias="${GME_SIGNING_ALIAS:?Set GME_SIGNING_ALIAS to the local keystore alias}"
: "${GME_SIGNING_PASSWORD:?Set GME_SIGNING_PASSWORD in the local environment}"

build_tools="$android_sdk_root/build-tools/$build_tools_version"
platform_jar="$android_sdk_root/platforms/$platform_version/android.jar"
aapt="$build_tools/aapt"
d8="$build_tools/d8"
zipalign="$build_tools/zipalign"
apksigner="$build_tools/apksigner"
for required in "$gme_android_jar" "$signing_keystore" "$platform_jar" "$aapt" "$d8" "$zipalign" "$apksigner"; do
  [[ -f "$required" ]] || { echo "Required local build input not found: $required" >&2; exit 1; }
done
command -v javac >/dev/null 2>&1 || { echo "A Java compiler is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is required to generate local BuildConfig" >&2; exit 1; }
[[ -d "$gme_android_jni_dir" ]] || { echo "GME_ANDROID_JNI_DIR is not a directory" >&2; exit 1; }

shopt -s nullglob
gme_native_libs=("$gme_android_jni_dir"/*.so)
((${#gme_native_libs[@]} > 0)) || { echo "No local GME .so files found in GME_ANDROID_JNI_DIR" >&2; exit 1; }

build_root="${GME_ADAPTER_BUILD_DIR:-$script_dir/build}"
run_dir="$build_root/run-$(date +%Y%m%d%H%M%S)-$$"
classes_dir="$run_dir/classes"
dex_dir="$run_dir/dex"
apk_dir="$run_dir/apk"
build_config="$run_dir/generated/com/gmebot/test/BuildConfig.java"
mkdir -p "$classes_dir" "$dex_dir" "$apk_dir/lib/x86_64" "$(dirname -- "$build_config")"

node -e 'const fs=require("node:fs");const path=require("node:path");const app=process.env.GME_SDK_APP_ID||"";const key=process.env.GME_SDK_KEY||"";const id=Number(app);if(!/^\d+$/.test(app)||!Number.isSafeInteger(id)||id<1||Buffer.byteLength(key,"utf8")!==16){console.error("GME_SDK_APP_ID and a 16-byte GME_SDK_KEY are required in the local environment");process.exit(1)}const source="package com.gmebot.test;\nfinal class BuildConfig {\n  static final int GME_SDK_APP_ID = "+id+";\n  static final String GME_SDK_KEY = "+JSON.stringify(key)+";\n}\n";fs.writeFileSync(process.argv[1],source,{encoding:"utf8",mode:0o600});' "$build_config"

javac -source 8 -target 8 -classpath "$platform_jar:$gme_android_jar" \
  -d "$classes_dir" \
  "$script_dir/src/com/gmebot/test/MainActivity.java" "$build_config"
class_files=("$classes_dir"/com/gmebot/test/*.class)
# Dex our classes together with the bundled GME SDK jar; the GME Java classes
# (ITMGContext, AuthBuffer, ...) must live in the APK's dex or the app crashes
# with NoClassDefFoundError the moment it touches the SDK at runtime.
"$d8" --min-api 21 --lib "$platform_jar" --output "$dex_dir" "${class_files[@]}" "$gme_android_jar"
cp "$dex_dir/classes.dex" "$apk_dir/classes.dex"
cp "${gme_native_libs[@]}" "$apk_dir/lib/x86_64/"

base_apk="$run_dir/base.apk"
unsigned_apk="$run_dir/unaligned.apk"
aligned_apk="$run_dir/aligned.apk"
output_apk="$run_dir/gme-music-bot-redroid.apk"
"$aapt" package -f -M "$script_dir/AndroidManifest.xml" -I "$platform_jar" -F "$base_apk"
(cd "$apk_dir" && "$aapt" add "$base_apk" classes.dex lib/x86_64/*.so)
"$zipalign" -f 4 "$base_apk" "$unsigned_apk"
"$apksigner" sign --ks "$signing_keystore" --ks-key-alias "$signing_alias" \
  --ks-pass env:GME_SIGNING_PASSWORD --key-pass env:GME_SIGNING_PASSWORD \
  --out "$aligned_apk" "$unsigned_apk"
"$apksigner" verify "$aligned_apk"
mv "$aligned_apk" "$output_apk"
echo "Built local Redroid adapter APK: $output_apk"
echo "Build output and generated local credentials are under the ignored build directory."
