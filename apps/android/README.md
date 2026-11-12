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
