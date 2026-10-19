# Aduna for Android

A small native shell (Capacitor) that opens the live site at `https://aduna.onrender.com/app` and adds what the web version could not do reliably: **native push notifications through Firebase Cloud Messaging (FCM)**. Android draws the notifications itself, so they no longer depend on Chrome's Web Push, the service worker, or the page being alive.

Because the shell loads the live site, **web updates reach the app immediately**. You only rebuild the app when this folder changes (icon, permissions, version).

```
mobile/capacitor.config.json   app id, name, the site it opens, offline page
mobile/www/                    tiny local pages (redirect + "can't reach Aduna")
mobile/overlay/res/            launcher + notification icons (generated from client/public/icon-*.png)
mobile/scripts/prepare-android.mjs   creates mobile/android and applies permissions, icons, signing, version
.github/workflows/android.yml  builds it on GitHub (Actions > Build Android app > Run workflow)
server/fcm.js                  server side: sends to Android devices (no extra dependencies)
client/src/notify.js           page side: registers the phone's token when running inside the app
```

## One-time setup

### 1. Firebase (gives you push)
1. <https://console.firebase.google.com> > Add project (Analytics not needed).
2. Project overview > **Add app > Android**. Package name: `com.aduna.app` (must match `appId` in `capacitor.config.json`; **it can never change once published**).
3. Download **google-services.json**. In GitHub: repo > Settings > Secrets and variables > Actions > New secret **`GOOGLE_SERVICES_JSON`** = the file's contents.
4. Firebase > Project settings > **Service accounts > Generate new private key**. In Render > Environment add **`FCM_SERVICE_ACCOUNT`** = the whole JSON file contents (base64 of it also works). Redeploy. Keep that file private; anyone with it can send pushes as you.

### 2. Signing key (needed to publish or to update an installed app)
Run once on your computer (needs Java; keep the file and passwords somewhere safe, **losing it means you cannot update the app**):
```bash
keytool -genkeypair -v -keystore aduna.keystore -alias aduna -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 aduna.keystore      # macOS: base64 -i aduna.keystore
```
GitHub secrets: **`ANDROID_KEYSTORE_BASE64`** (that base64 text), **`ANDROID_KEYSTORE_PASSWORD`**, **`ANDROID_KEY_ALIAS`** (`aduna`), **`ANDROID_KEY_PASSWORD`**.
Without these the workflow still builds a debug APK you can install to test, but it cannot go on Google Play.

## Build
GitHub > Actions > **Build Android app** > Run workflow. When it finishes, download the **Aduna-Android** artifact:
- `app-release.apk`: install directly (Settings > allow installs from this source), or host it on your site.
- `app-release.aab`: the file Google Play wants.
- `app-debug.apk` (no signing secrets): testing only.

**On your own Windows PC instead: double-click `mobile\build-apk.bat`.** You need Node.js (LTS) and Android Studio (it brings Java and the Android SDK; open it once so it downloads the SDK). The APK appears in `mobile\dist`. Optional files, placed next to the bat: `google-services.json` (push notifications) and `aduna.keystore` (release APK + AAB; it asks for the password, alias defaults to `aduna`). If it says it cannot find Java 21, put the path of a JDK 21 folder (the one containing `bin\java.exe`, for Android Studio usually `...\Android Studio\jbr`) on the first line of `mobile\java-home.txt`. Without the keystore you get a debug APK. Never commit either file (they are git-ignored).

## Test checklist (do this on a real phone before publishing)
1. Install, open, log in. Settings > Notifications > **Turn on** (Android asks for permission).
2. **Check notifications** should show every row green. **Send a test push from the server**, then lock the phone or switch apps: the banner appears.
3. Have a friend DM you and @mention you while the app is closed (swipe it away). Tap the notification: it should open that chat.
4. Call a friend: check the camera and microphone prompts appear and work.
5. Upload a photo from the gallery. Check how the layout looks under the status bar and navigation bar.
6. If pushes arrive late on some phones: Settings > Apps > Aduna > Battery > Unrestricted (Samsung, Xiaomi and others kill background apps aggressively).

## Publishing on Google Play
- Play Console developer account (one-time US$25). New personal accounts must usually run a **closed test with about 12 testers for 14 days** before production; check the current rule in the Console.
- Create the app, upload the `.aab` (let Google manage app signing; your keystore is then the *upload* key), fill in the store listing (`play-store-icon-512.png` is the 512x512 icon), content rating and the **Data safety** form (accounts, messages, photos, email, purchases via Stripe; data is encrypted in transit and at rest), and give a **privacy policy URL**.
- Each upload needs a higher version code; the workflow uses the run number automatically.
- Google rejects apps that are only a thin website wrapper. Native push, camera/microphone calls and file upload help, but describe those features in the listing.

## Known limits
- **Incoming calls are a high-priority notification, not a full-screen ringing screen.** A true phone-style ring needs extra native code (a foreground service and full-screen intent).
- **Downloading attachments** (non-image files) may not work inside the Android WebView; images and video display fine. This needs a small native download handler if you want it.
- DM notifications say who wrote but not what, when the app is closed (DMs are end-to-end encrypted; the server cannot read them). That is the same as the web version.
- Render's free plan sleeps; the first launch after a long gap can show "Can't reach Aduna" until the server wakes. Tap Try again.
- iPhone is not covered (needs a Mac, Xcode and a US$99/year Apple account). iPhones keep using the installed web app.
- Not yet run on a device or built in CI by the person who wrote it: do the checklist above and report what breaks.
