# Android 版本

安卓工程位于 `android/`，使用系统 WebView 加载 APK 内的 `dist/` 游戏资源。

## 离线保证

- AndroidManifest 不声明 `INTERNET` 权限。
- WebView 主动阻止所有网络请求。
- 系统云备份已关闭，游戏数据不会上传到备份服务。
- HTML、CSS 和 JavaScript 直接打包进 APK。
- Android 与浏览器版本共用同一份 `dist/`，以后修改游戏会自动进入下一次 APK 构建。
- 本地资源通过应用内部 HTTPS 域名加载，使 Web Worker 能在后台执行 AI 胜率模拟，但不会产生外部网络请求。

## 构建

```bash
cd android && ./build-apk.sh
```

脚本直接调用 Android SDK 官方构建工具（`aapt2`、`d8`、`zipalign`、`apksigner`），
不需要 Gradle，也不需要联网。生成的安装包位于项目根目录的 `KrPoker.apk`。

工具链默认使用 `~/android-build`，可用环境变量 `ANDROID_TOOLCHAIN` 覆盖。

> ⚠️ 工具链**不要**放在 `/private/tmp`。该目录会被 macOS 定期清理，
> 一旦清除就需要重新下载约 1.2 GB。本项目早期版本正是因此丢失过整套工具链。

## 重建工具链

若 `~/android-build` 不存在，按以下步骤准备（约需 1.2 GB 磁盘、下载 330 MB）：

```bash
mkdir -p ~/android-build/{downloads,jdk,sdk}

# JDK 17（国内镜像，版本需与脚本中的路径一致）
cd ~/android-build/downloads
curl -fLO https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/aarch64/mac/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz
tar -xzf OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz -C ~/android-build/jdk/

# Android 命令行工具
curl -fLO https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip
mkdir -p ~/android-build/sdk/cmdline-tools
unzip -q commandlinetools-mac_arm64-15859902_latest.zip -d ~/android-build/sdk/cmdline-tools/
mv ~/android-build/sdk/cmdline-tools/cmdline-tools ~/android-build/sdk/cmdline-tools/latest

# SDK 组件（需要 JDK 在 PATH 中）
export JAVA_HOME=~/android-build/jdk/jdk-17.0.20.1+1/Contents/Home
SDKM=~/android-build/sdk/cmdline-tools/latest/bin/sdkmanager
yes | "$SDKM" --licenses
"$SDKM" platform-tools platforms/android-35 build-tools/35.0.0
```

Intel 芯片的 Mac 需把 JDK 换成 `x64/mac`、命令行工具换成 `commandlinetools-mac-*`。

## 签名

签名密钥存放在 `~/android-build/kr-poker-debug.keystore`（口令均为 `android`）。

**这个文件必须长期保留。** Android 要求同一包名 `com.riverstone.poker` 必须用同一密钥签名，
换密钥后新包无法覆盖安装，必须先卸载旧版本——这同时会清除本地训练数据。

## 构建要求

| 组件 | 版本 |
| --- | --- |
| JDK | 17（脚本内固定为 17.0.20.1+1） |
| Android SDK Platform | 35 |
| Android SDK Build Tools | 35.0.0 |
| 最低支持版本 | Android 7.0（API 24） |
