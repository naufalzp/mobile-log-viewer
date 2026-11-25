# Mobile Log Viewer

One local web page for the logs of every connected **Android phone**, **iPhone** and **iOS simulator**, live, side by
side, with search, level filters and crash highlighting.

- **Zero dependencies.** No `npm install`. One Node file plus a static page.
- **Plug and go.** Devices are found automatically every 3 s and start streaming on their own.
- **Local only.** Listens on `127.0.0.1` and rejects requests from other hosts or origins, because logs often carry
  tokens and personal data.

## Requirements

- **Node.js 18+**
- The device tools for the platforms you use. A missing tool only skips that platform.

| Platform | Tool | Install |
| --- | --- | --- |
| Android (USB or wireless adb) | `adb` | Android SDK Platform-Tools. Found on `PATH`, `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Library/Android/sdk` |
| iPhone (USB or Wi-Fi pairing) | `idevice_id`, `ideviceinfo`, `idevicesyslog` | `brew install libimobiledevice` |
| iOS simulator | `xcrun simctl` | Xcode |

Built and tested on macOS. Android-only use should also work on Linux.

## Quick start

```sh
git clone <this-repo> mobile-log-viewer
cd mobile-log-viewer
cp .env.example .env   # then put your app ids in it (see Configuration)
./mlog
```

```sh
./mlog              # starts on http://localhost:7799 and opens the browser
./mlog --no-open    # do not open the browser
PORT=7800 ./mlog    # use another port
node server.mjs     # same thing without the launcher
```

Stop it with `Ctrl-C`.

## Configuration

### Your apps: `.env`

Tell the viewer which processes are yours. Copy `.env.example` to `.env` (git-ignored) and fill it in:

```sh
# Android package names, comma separated. Matched by prefix, so com.example.myapp
# also covers com.example.myapp.debug and com.example.myapp:remote.
MLOG_ANDROID_APPS=com.example.myapp

# iOS process names: the executable of the app and of each extension.
MLOG_IOS_APPS=MyApp,MyAppNotificationExtension
```

Real environment variables win over `.env`, so a one-off run works too:

```sh
MLOG_IOS_APPS=OtherApp ./mlog
```

With no apps set for a platform, **App only** does not filter that platform and iOS **App** mode streams the whole
device.

### Other settings: `config.json`

| Key | Meaning |
| --- | --- |
| `port` | HTTP port (the `PORT` env var wins) |
| `autoStart` | Start streaming as soon as a device is found |
| `bufferPerDevice` | Log entries kept in memory per device |
| `androidBacklog` | Lines of existing logcat history read when an Android device first connects |
| `iosDefaultMode` | `app` (only your processes) or `all` (whole device) for new iOS devices |
| `apps` | `{ "android": [...], "ios": [...] }`, same as the env vars, which override it |
| `adbPath` | Optional explicit path to `adb` |

Personal overrides go in **`config.local.json`** (same keys, read after `config.json`, git-ignored). The viewer also
writes `ignoreDevices` there when you click *Forget* on a device, for example a phone still paired over Wi-Fi that you
no longer want listed.

## What it reads

| Device | Source | Notes |
| --- | --- | --- |
| Android | `adb logcat -v threadtime,year` | The last `androidBacklog` lines first, then live. Process names come from `ps` and are filled in as they become known. |
| iPhone | `idevicesyslog` | **App** mode asks the phone only for the processes in `MLOG_IOS_APPS`. **All** is the whole phone (quiet list applied) and is very noisy. |
| iOS simulator (booted) | `xcrun simctl spawn … log stream --style ndjson` | Same App / All modes. |

A device that unplugs keeps its logs in the list and resumes streaming when it returns. A restarted Android stream
continues from the last line it saw, so nothing is duplicated. An iOS stream that goes quiet for 45 s is restarted,
since `idevicesyslog` can stay alive but stop delivering after a reinstall, sleep or Wi-Fi drop.

## Using it

### Search

All words must match (message, tag or process).

| Syntax | Example |
| --- | --- |
| Plain words | `timeout login` |
| Field filters | `tag:OkHttp`, `proc:debug`, `dev:pixel`, `pid:1234`, `lvl:e` |
| Exclude | `-word`, `-tag:Network` |
| Regex | `/user_id=\d+/` |
| Phrase | `"connection reset"`, `tag:"My Tag"` |

### Filters and tools

- **Levels** `V D I W E F` set the minimum level.
- **App only** shows only your app processes (`MLOG_ANDROID_APPS` / `MLOG_IOS_APPS`).
- **Hide iOS system** hides lines your app process logs from Apple frameworks (Network, CFNetwork, UIKitCore…) below
  Error. They can outnumber the app's own lines about 100 to 1; their errors still show.
- **Click a row** for the full message, pretty-printed JSON, and quick filters: *Only tag*, *Hide tag*, *Show around*.
- **Multi-line logs** (stack traces, HTTP dumps) from one call are kept as one entry.
- **Split messages** logged as `… | part k/N` are joined back into one entry with the JSON formatted. Handy because
  `os_log` truncates long messages, so an app can split long API bodies this way.
- **Crashes** (Android `FATAL EXCEPTION`, iOS uncaught exceptions, `SIGABRT`…) are highlighted. The red counter in the
  footer jumps between them.
- **Pause** keeps collecting while the view stands still. **Mark** draws a divider, useful right before reproducing a
  bug. **Export** downloads what the current filters show.

### Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `Esc` (in search) | Clear search, then leave the box |
| `p` | Pause / resume |
| `m` / `M` | Insert a marker / a named marker |
| `e` | Toggle errors only |
| `w` | Toggle line wrap |
| `c` | Clear all logs |
| `G` or `End` | Jump to latest |

## iOS: why some text shows as `<private>`

The device log redacts interpolated values in `Logger` / `os_log` messages unless they are marked public. To see a
value, log it as `\(value, privacy: .public)` (in debug builds only, for anything sensitive). `print()` never reaches
the device log.

## How it works

`server.mjs` spawns one log process per device, parses each line into `{ts, level, process, pid, tid, tag, message}`,
keeps a ring buffer per device and pushes batches every 50 ms to the page over Server-Sent Events. The page
(`public/`) is plain HTML, CSS and JavaScript with no build step. Filtering happens in the browser.

```
mlog                launcher script
server.mjs          device discovery, log streaming, HTTP + SSE server
config.json         shared settings
.env.example        template for .env (your app ids, git-ignored)
config.local.json   personal overrides (git-ignored)
public/             the web page
```

## Security note

Logs can contain access tokens, personal data and API payloads. The server binds to `127.0.0.1` only and checks the
`Host` and `Origin` headers, so other machines and other websites cannot read it. Be careful with what you export
and share.

## License

[MIT](LICENSE)
