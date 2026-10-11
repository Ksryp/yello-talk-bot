#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"
sdk_dir="$script_dir/vendor-sdk"
sdk_lib_dir="$sdk_dir/lib"

if [[ ! -f "$sdk_lib_dir/libOpenSLES.so" ]]; then
  if [[ ! -f "$sdk_lib_dir/libgmesdk.so" || ! -f "$sdk_dir/stubs/build_stubs.sh" ]]; then
    echo "Bundled GME SDK files are missing under $sdk_dir" >&2
    exit 1
  fi
  bash "$sdk_dir/stubs/build_stubs.sh"
fi

cxx="${CXX:-g++}"
command -v "$cxx" >/dev/null 2>&1 || {
  echo "C++ compiler not found: $cxx" >&2
  exit 1
}
command -v pkg-config >/dev/null 2>&1 || {
  echo "pkg-config is required to locate libcurl" >&2
  exit 1
}
pkg-config --exists libcurl || {
  echo "libcurl development files are required (for example libcurl4-openssl-dev)" >&2
  exit 1
}

output="${1:-build/gme-music-bot-linux}"
if [[ "$output" != /* ]]; then
  output="$script_dir/$output"
fi
mkdir -p "$(dirname -- "$output")"
read -r -a curl_flags <<< "$(pkg-config --cflags --libs libcurl)"

"$cxx" -std=c++17 -O2 -pthread -rdynamic \
  -I"$sdk_dir/include" -I"$script_dir/../windows-native" \
  main_linux.cpp -o "$output" \
  "${curl_flags[@]}" -ldl -lz -lm \
  -Wl,--disable-new-dtags -Wl,-rpath,'$ORIGIN/../vendor-sdk/lib'

echo "Built $output"
echo "Bundled GME SDK runtime libraries: $sdk_lib_dir"
