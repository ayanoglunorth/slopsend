---
name: slopsend
description: Build the current Android project as a debug APK and send it to the user's phone over the LocalSend protocol. Use when the user asks to send, push, or install the app on their phone, or to test it on the phone.
---

# slopsend

The script is `scripts/slopsend.mjs`, next to this file. It needs only Node. Below, `slopsend` means `node <this skill's directory>/scripts/slopsend.mjs`; use the full path.

slopsend only sends. It never builds. You build the debug APK, then send it.

1. Build the debug APK yourself, with the project's own tooling, unless you already built it in this session and nothing changed since. For example `gradlew assembleDebug` run in the folder that holds the Gradle wrapper (often `android/` in Flutter or React Native projects; on Windows call it as `.\gradlew.bat assembleDebug`), or `flutter build apk --debug`. A cold build can take several minutes: run it with a long timeout or in the background.
2. From the project root, run:

```
slopsend send
```

It picks the newest debug APK under the project, finds the phone on the Wi-Fi, and sends it. Output is one line and says how old the APK is; if that age is not what you expect, you sent a stale build, so build again and resend.

To send a specific file: `slopsend send path/to/app-debug.apk`.

## First run

The first `send` also pairs with the phone. Before running it, ask the user to open LocalSend on the phone (same Wi-Fi as this computer). The phone may show an "accept" prompt once; the user taps accept. The command then prints a one-time setup. Follow this order, it matters:

1. Start `slopsend favorite` in the background first. It listens for up to 5 minutes and prints a "phone contacted" line when the phone calls.
2. Only then give the user these steps, one by one, in their language:
   1. Open LocalSend on the phone, go to the Send tab.
   2. Find the entry named `slopsend-<computer name>` and tap its info icon. If it is missing, run `slopsend pair` and have the user look again.
   3. Switch on Favorite, then tap Add.
   4. Go to the Settings tab and switch on Quick Save for "Favorites" (not the plain "Quick Save", which accepts from everyone).
3. Wait for the "phone contacted" line, then the command ends by itself.

The computer must be listening while the user taps Add. If it is not, LocalSend shows "Connection refused" and no favorite is saved. In that case start `slopsend favorite` and have the user tap Add again. After this one-time setup the phone accepts without asking.

## After it succeeds

Tell the user the APK is on the phone and they need to tap Install (open the LocalSend notification or the Downloads folder). Do not try to install it yourself. Android requires that tap.

## If it fails

The error message says what to do. The common ones:

| Message starts with | Do this |
|---|---|
| `no LocalSend device found` | Ask the user to open LocalSend on the phone, same Wi-Fi. Retry once. If it still fails, ask for the phone's IP (LocalSend shows it) and run `slopsend send --ip <ip>`. |
| `phone not reachable` | Same: LocalSend open on the phone, same Wi-Fi. Retry once. |
| `phone rejected the transfer` | The one-time phone setup is missing. Run `slopsend favorite` in the background, ask the user to add this computer as Favorite in LocalSend (Send tab, info icon, Favorite, Add) and turn on Settings > Quick Save for "Favorites". If the computer is not in the Send tab list, run `slopsend pair` first so it shows up. |
| `phone certificate changed` | LocalSend was reinstalled on the phone. Ask the user, then run `slopsend pair`. |
| `no debug APK found` | The build has not produced an APK yet. Build the debug APK (see above), then run `slopsend send` again. |

Retry at most once for network errors. Do not loop.
