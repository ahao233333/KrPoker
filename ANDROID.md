# Android 版本

安卓工程位于 `android/`，使用系统 WebView 加载 APK 内的 `dist/` 游戏资源。

## 离线保证

- AndroidManifest 不声明 `INTERNET` 权限。
- WebView 主动阻止所有网络请求。
- 系统云备份已关闭，游戏数据不会上传到备份服务。
- HTML、CSS 和 JavaScript 直接打包进 APK。
- Android 与浏览器版本共用同一份 `dist/`，以后修改游戏会自动进入下一次 APK 构建。
- 本地资源通过应用内部 HTTPS 域名加载，使 Web Worker 能在后台执行 AI 胜率模拟，但不会产生外部网络请求。

## 构建要求

- JDK 17
- Android SDK 35
- Android SDK Build Tools 34.0.0 或更高兼容版本
- Gradle 8.9

构建工具保存在 `/private/tmp/riverstone-android-build`。修改游戏后，在 `android/` 目录运行 `./build-apk.sh` 即可重新构建。脚本直接调用 Android SDK 官方构建工具，不需要联网。生成的安装包位于：

`KrPoker.apk`
