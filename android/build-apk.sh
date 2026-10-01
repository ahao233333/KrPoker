#!/bin/sh
set -eu

export JAVA_HOME=/private/tmp/riverstone-android-build/jdk-17.0.20.1+1/Contents/Home
export ANDROID_SDK_ROOT=/private/tmp/riverstone-android-build/sdk
export ANDROID_USER_HOME=/private/tmp/riverstone-android-build/android-user
export GRADLE_USER_HOME=/private/tmp/riverstone-android-build/gradle-cache

BUILD_TOOLS=/private/tmp/riverstone-android-build/sdk/build-tools/35.0.0
ANDROID_JAR=/private/tmp/riverstone-android-build/sdk/platforms/android-35/android.jar
PROJECT_ROOT=/Users/Apple/develop/poker
ANDROID_PROJECT=/Users/Apple/develop/poker/android
BUILD_DIR=/Users/Apple/develop/poker/android/manual-build
KEYSTORE=/private/tmp/riverstone-android-build/riverstone-debug.keystore

rm -rf /Users/Apple/develop/poker/android/manual-build
mkdir -p /Users/Apple/develop/poker/android/manual-build/generated /Users/Apple/develop/poker/android/manual-build/classes /Users/Apple/develop/poker/android/manual-build/dex

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
    --version-code 7 \
    --version-name 1.5.0 \
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

if [ ! -f "$KEYSTORE" ]; then
    "$JAVA_HOME/bin/keytool" -genkeypair \
        -keystore "$KEYSTORE" \
        -storepass android \
        -alias androiddebugkey \
        -keypass android \
        -dname "CN=Riverstone Poker, OU=Offline, O=Riverstone, L=Local, ST=Local, C=CN" \
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
cp "$BUILD_DIR/KrPoker.apk" "$PROJECT_ROOT/RiverstonePoker.apk"
