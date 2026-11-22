#!/bin/sh
# Run inside the release Docker image. Export only the runtime and dependency licenses.
set -eu
dest=/export/runtime
mkdir -p "$dest/bin" "$dest/lib" "$dest/exec" "$dest/python/lib" "$dest/licenses"
version=$(python3 -c 'import sys; print("python%d.%d" % sys.version_info[:2])')
cp -L /usr/local/bin/node "$dest/bin/node"
cp -L /usr/bin/"$version" "$dest/exec/python"
cp -L /usr/bin/ffmpeg /usr/bin/ffprobe "$dest/exec/"
cp -aL "/usr/lib/$version" "$dest/python/lib/"
cp -aL "/opt/media/lib/$version/site-packages" "$dest/python/lib/$version/"
cp -L /lib64/ld-linux-x86-64.so.2 "$dest/exec/loader"
# Dependencies loaded by Python extensions (including PyAV and CTranslate2) are separate from the interpreter's.
for binary in "$dest"/exec/python "$dest"/exec/ff*; do ldd "$binary"; done > /export/ldd-list
find "/usr/lib/$version/lib-dynload" "/opt/media/lib/$version/site-packages" -type f -name '*.so*' -exec ldd {} \; >> /export/ldd-list 2>/dev/null
awk '$2 == "=>" && ($3 ~ /^\/lib\// || $3 ~ /^\/usr\/lib\//) {print $3}' /export/ldd-list | sort -u | while read -r file; do cp -L "$file" "$dest/lib/"; done
for file in /usr/share/doc/*/copyright; do package=$(basename "$(dirname "$file")"); cp -L "$file" "$dest/licenses/$package"; done
for executable in python ffmpeg ffprobe; do
  cat > "$dest/bin/$executable" <<'WRAPPER'
#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PYTHONHOME="$root/python"
export PYTHONNOUSERSITE=1
export PYTHONPATH="$root/python/lib/python3.11/site-packages"
exec "$root/exec/loader" --library-path "$root/lib" "$root/exec/$(basename "$0")" "$@"
WRAPPER
  chmod +x "$dest/bin/$executable"
done
"$dest/bin/python" -c 'import av, faster_whisper, yt_dlp'
"$dest/bin/ffmpeg" -version >/dev/null
"$dest/bin/ffprobe" -version >/dev/null
"$dest/bin/node" --version
