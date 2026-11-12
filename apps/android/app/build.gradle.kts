plugins {
    id("com.android.application")
}

val releaseStorePath = System.getenv("FLOWPAY_ANDROID_KEYSTORE_PATH")
val releaseStorePassword = System.getenv("FLOWPAY_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("FLOWPAY_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("FLOWPAY_ANDROID_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword
).all { !it.isNullOrBlank() }

android {
    namespace = "com.flowpay.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.flowpay.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
