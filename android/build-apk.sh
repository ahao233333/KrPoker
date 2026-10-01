#!/bin/sh
set -eu

# 工具链放在 ~/android-build，不用 /private/tmp —— 后者会被 macOS 定期清理。
# 重建方法见 ANDROID.md。
TOOLCHAIN="${ANDROID_TOOLCHAIN:-$HOME/android-build}"

export JAVA_HOME="$TOOLCHAIN/jdk/jdk-17.0.20.1+1/Contents/Home"
export ANDROID_SDK_ROOT="$TOOLCHAIN/sdk"
export ANDROID_USER_HOME="$TOOLCHAIN/android-user"
export GRADLE_USER_HOME="$TOOLCHAIN/gradle-cache"

BUILD_TOOLS="$ANDROID_SDK_ROOT/build-tools/35.0.0"
ANDROID_JAR="$ANDROID_SDK_ROOT/platforms/android-35/android.jar"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_PROJECT="$PROJECT_ROOT/android"
BUILD_DIR="$ANDROID_PROJECT/manual-build"
KEYSTORE="$TOOLCHAIN/kr-poker-debug.keystore"

if [ ! -x "$BUILD_TOOLS/aapt2" ]; then
    echo "缺少构建工具：$BUILD_TOOLS" >&2
    echo "请按 ANDROID.md 的说明先准备工具链。" >&2
    exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/generated" "$BUILD_DIR/classes" "$BUILD_DIR/dex"

"$BUILD_TOOLS/aapt2" compile \
    --dir "$ANDROID_PROJECT/app/src/main/res" \
    -o "$BUILD_DIR/compiled-res.zip"

"$BUILD_TOOLS/aapt2" link \
    -o "$BUILD_DIR/app-unsigned-unaligned.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$ANDROID_PROJECT/app/src/main/AndroidManifest.xml" \
    --java "$BUILD_DIR/generated" \
    --min-sdk-version 24 \
    --target-sdk-version 35 \
    --version-code 8 \
    --version-name 2.0.0 \
    -A "$PROJECT_ROOT/dist" \
    "$BUILD_DIR/compiled-res.zip"

"$JAVA_HOME/bin/javac" \
    -source 8 \
    -target 8 \
    -bootclasspath "$ANDROID_JAR" \
    -d "$BUILD_DIR/classes" \
    "$BUILD_DIR/generated/com/riverstone/poker/R.java" \
    "$ANDROID_PROJECT/app/src/main/java/com/riverstone/poker/MainActivity.java"

"$JAVA_HOME/bin/jar" cf "$BUILD_DIR/classes.jar" -C "$BUILD_DIR/classes" .
"$BUILD_TOOLS/d8" --min-api 24 --lib "$ANDROID_JAR" --output "$BUILD_DIR/dex" "$BUILD_DIR/classes.jar"
/usr/bin/zip -q -j "$BUILD_DIR/app-unsigned-unaligned.apk" "$BUILD_DIR/dex/classes.dex"
"$BUILD_TOOLS/zipalign" -f -p 4 "$BUILD_DIR/app-unsigned-unaligned.apk" "$BUILD_DIR/app-aligned.apk"

# 密钥库必须长期保留：换密钥会导致新包无法覆盖安装旧版本。
if [ ! -f "$KEYSTORE" ]; then
    echo "未找到密钥库，正在新建：$KEYSTORE" >&2
    echo "注意：若手机已装过用其它密钥签名的同包名应用，需先卸载。" >&2
    "$JAVA_HOME/bin/keytool" -genkeypair \
        -keystore "$KEYSTORE" \
        -storepass android \
        -alias androiddebugkey \
        -keypass android \
        -dname "CN=KrPoker, OU=Offline, O=KrPoker, L=Local, ST=Local, C=CN" \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000
fi

"$BUILD_TOOLS/apksigner" sign \
    --ks "$KEYSTORE" \
    --ks-pass pass:android \
    --key-pass pass:android \
    --out "$BUILD_DIR/KrPoker.apk" \
    "$BUILD_DIR/app-aligned.apk"

"$BUILD_TOOLS/apksigner" verify --verbose "$BUILD_DIR/KrPoker.apk"
cp "$BUILD_DIR/KrPoker.apk" "$PROJECT_ROOT/KrPoker.apk"
echo "已生成：$PROJECT_ROOT/KrPoker.apk"
