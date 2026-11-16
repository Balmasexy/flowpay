# FlowPay Android app

This Android application packages the existing FlowPay web client at
`https://flowpay-web-jx7i.onrender.com/` in an Android WebView.

It reuses the web client's authentication and backend API. No Paystack, VTpass,
Neon, or other service credentials are embedded in the APK or AAB.

## Build locally

From this directory, with JDK 21, Android SDK platform 36, and Gradle 9.9.1:

```sh
gradle :app:assembleDebug :app:bundleRelease
```

Outputs:

- `app/build/outputs/apk/debug/app-debug.apk` — debug-signed installable APK.
- `app/build/outputs/bundle/release/app-release.aab` — Play Store bundle. It is unsigned unless a release keystore is configured.

## GitHub Actions build

The dedicated Android workflow runs on main-branch Android changes or manually from Actions. It builds and verifies the debug APK, release APK, and release AAB, then uploads them as a 30-day workflow artifact. The debug APK is installable for device testing. A release APK/AAB is Play-distribution ready only when all four release-signing secrets below are configured; otherwise the workflow labels the release outputs as unsigned.

Use **Actions → FlowPay Android APK and AAB → Run workflow** to build on demand. Download the `flowpay-android-<commit>` artifact from the completed run.

## CI release signing

Configure these GitHub Actions repository secrets to sign the release AAB:

- `FLOWPAY_ANDROID_KEYSTORE_BASE64`
- `FLOWPAY_ANDROID_KEYSTORE_PASSWORD`
- `FLOWPAY_ANDROID_KEY_ALIAS`
- `FLOWPAY_ANDROID_KEY_PASSWORD`

Never commit the keystore or passwords. Without those secrets CI still produces the debug APK and an unsigned release AAB.

This is a WebView packaging target, not a native rewrite of the React customer experience.
The web client remains responsible for account logic, authentication, provider requests,
and server-side authorization.
