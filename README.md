# slopsend

A small command-line sender for the open LocalSend protocol. Your coding agent builds a debug APK and slopsend drops it on your phone, with no cable and no pairing dialog after the first time.

The phone side is the regular LocalSend app. Nothing extra gets installed on the phone.

```
$ slopsend send
sent app-debug.apk (24.1 MB) to "Pixel 8". On the phone, open the LocalSend notification or Downloads and tap Install.
```

## Install

You need Node 20 or newer, the [LocalSend](https://localsend.org) app on your phone, and an Android project your agent can build.

One command, run inside your project:

```
npx skills add ayanoglunorth/slopsend
```

To make it available in every project instead, add `-g`. The command asks which agent to install for (Claude Code, Codex, Cursor and others supported by the [skills CLI](https://github.com/vercel-labs/skills)). The script ships inside the skill with its one dependency bundled, so there is nothing else to install and nothing to put on your PATH.

## First use

Open your agent in your Android project and say `/slopsend`, or ask it to send the app to your phone. Before that, open LocalSend on the phone and keep the phone on the same Wi-Fi as your computer.

The first run finds the phone and sends the file. The phone will ask you to accept it once. After that, do the one-time setup below so the phone stops asking. The agent can walk you through it.

### One-time setup (about a minute)

This tells LocalSend to trust your computer. Do the steps in this order.

1. On your computer, run `slopsend favorite` (your agent can run it for you) and leave it running. LocalSend checks a new favorite by contacting your computer, so it has to be listening in the next steps. If Windows asks about network access, allow it on private networks.
2. On the phone, open LocalSend and go to the **Send** tab.
3. Find the entry named `slopsend-<your computer name>` in the nearby devices list. If it is not there, run `slopsend pair` on the computer and look again.
4. Tap the **info icon** on that entry.
5. Switch on **Favorite**, then tap **Add**. If it works, `slopsend favorite` prints "phone contacted this computer".
6. Go to the **Settings** tab, find the Receive section, and switch on **Quick Save for "Favorites"**. Do not switch on the plain **Quick Save**; that accepts files from everyone on the network.

From now on the phone takes the APK without asking. You still tap Install: Android does not allow an app to install an APK silently, and that part is on purpose.

If the scan finds nothing (some routers isolate Wi-Fi clients), give the phone's IP, which LocalSend shows on its home screen: `slopsend send --ip 192.168.1.23`.

To run it without an agent: `node scripts/slopsend.mjs send` from your project root, using the path of the installed skill.

## How it works

LocalSend identifies a sender by its TLS certificate. slopsend creates one certificate on first run (`~/.slopsend/`) and keeps it. Adding it as a Favorite, with Quick Save for Favorites on, is what lets the phone accept without asking. The phone's own certificate is pinned at pairing, so a different device answering on the same address is refused.

## Troubleshooting

| What you see | What it means |
|---|---|
| LocalSend shows `Connection refused` when you tap Add | `slopsend favorite` was not running at that moment. Start it, then tap Add again. |
| `favorite` ends with "never contacted this computer" | Windows Firewall is blocking Node.js (allow it on private networks), the phone is on another network, or Add was tapped before the command started. |
| `favorite` says the port is in use | The LocalSend desktop app is open on this computer. Close it and retry. |
| The phone still asks to accept every time | Favorite was not saved, or Quick Save for "Favorites" is off. Do the one-time setup again. |
| `phone did not answer in time` | The phone is showing an accept prompt or is asleep. Look at the phone and retry. |
| `phone certificate changed` | LocalSend was reinstalled on the phone. Run `slopsend pair`. |

## Limits

- Sends one file at a time, and only sends. It does not receive.
- The phone's LocalSend must be open. Android may stop it in the background.
- Tested against LocalSend 1.18.x (protocol v2.2) on one phone. If LocalSend changes its protocol this may break.
- It finds the phone again by scanning the local /24 network if the address changed. Other network layouts need `--ip`.
- It does not build. Your agent (or you) builds the debug APK first; `slopsend send` then picks the newest one under the project, or you pass a path: `slopsend send path/to/app.apk`.

## Development

```
npm install
npm test
npm run build   # bundles src/ into skills/slopsend/scripts/slopsend.mjs
```

`skills/slopsend/scripts/slopsend.mjs` is generated and committed on purpose. `npx skills add` copies the skill folder as it is, so shipping the bundle is what lets users install with one command and no `npm install`. Rebuild it after changing `src/` and commit the result. It is marked as generated, so GitHub collapses it in diffs.

## Not affiliated with LocalSend

slopsend is not connected to the LocalSend project and is not endorsed by it. "LocalSend" is the name of their app and appears here only to say what this tool works with. The code is written from scratch against the public [LocalSend protocol](https://github.com/localsend/protocol) and contains none of the LocalSend app's source.

Use it on your own devices and on networks you trust. Your private key lives in `~/.slopsend/key.pem`; don't share it. The software comes as is, without warranty, under the MIT license.
