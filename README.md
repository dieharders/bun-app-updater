# bun-app-updater

In-app updates for a Bun app: check a release feed, download this platform's release, verify
it, install it, relaunch. The app supplies a config and two routes.

It has no dependencies.

## What it assumes about the app

- A `bun build --compile` executable, installed in one of two layouts:
  - **bundle** (macOS): `<Name>.app/Contents/MacOS/<exe>`, codesigned.
  - **directory** (Windows, Linux): the executable in a directory, with whatever the build
    staged beside it.
- A release is installed **whole, from the file a person downloads**. `assetName(version,
  target)` names it, where `target` is `windows-x64`, `darwin-arm64`, `linux-x64`, …:
  - **macOS: the DMG.** The updater mounts it read-only, copies the `.app` out beside the
    installed one with `ditto`, runs `codesign --verify --deep --strict`, and exchanges the two
    in one atomic step (`renamex_np` with `RENAME_SWAP`). The restart starts the new copy.
  - **Windows: the installer.** The updater downloads and verifies it, and nothing is replaced
    while the app runs: the installer is started as the app quits, with the arguments the app's
    `installer` config gives it — install unattended into the current folder, wait for the
    app's process to exit, and start the app again when the user asked for a restart.
  - **Linux: nothing in place.** A package install needs root. `check()` reports why, and the
    app offers the release page instead.
- The install location is **writable by the user** (per-user installs on Windows, a dragged
  `.app` on macOS). Where it is not, `check()` says why and the app offers a download page.
- A release feed. Built in: **GitHub Releases** (listed and filtered by tag prefix — never
  `/releases/latest`, which a repo shared with another project would hijack) and a **JSON
  release** at any URL (for an app that hosts its own feed, and for testing against a local
  file).
- The feed lists a **SHA-256 for the download** (GitHub computes one for every asset). A
  download with no checksum is refused (`unverified`), never installed on trust.

## Installing it as a submodule

This repo is not published to npm. An app takes it as a **git submodule inside a Bun
workspace**, so the app compiles this source directly (the `exports` map points at `src/*.ts`;
there is no build step) and pins the exact commit it was tested against.

1. Add the submodule where your workspace globs will find it. With a root `package.json` of

   ```json
   { "workspaces": ["app", "packages/*"] }
   ```

   run, from the repo root:

   ```sh
   git submodule add -b master https://github.com/dieharders/bun-app-updater.git packages/updater
   ```

   The folder name does not matter; the package is resolved by its **name**, `bun-app-updater`,
   whatever the path.

2. Depend on it from the app's `package.json` and install:

   ```json
   { "dependencies": { "bun-app-updater": "workspace:*" } }
   ```

   ```sh
   bun install
   ```

   Bun links it at `app/node_modules/bun-app-updater` and records it in the lockfile by path.

3. Import it by name, including the subpaths:

   ```ts
   import { createUpdater, githubReleases } from "bun-app-updater";
   import { writeLocalFeed } from "bun-app-updater/feed";
   ```

**Fresh clones and CI** need the submodule checked out before `bun install`, which refuses to run
with a workspace member missing:

```sh
git clone --recurse-submodules <your-app>      # or: git submodule update --init --recursive
```

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

**Moving the pin.** The submodule is a commit, not a branch: `git -C packages/updater pull`
(or `checkout <commit>`), run your app's tests, then commit the new pointer in your repo.
Consumer-facing shapes — `UpdaterConfig`, `UpdateInfo`, `InstallEvent`, `InstallErrorCode`,
`InstallerHandoff` — are versioned in `package.json`.

Without a workspace, the same thing works with a path dependency
(`"bun-app-updater": "file:./vendor/bun-app-updater"`) or by copying the folder in; the
submodule is what keeps every app on one source.

## Dropping it into an app

1. Install it as above.
2. Configure it once, somewhere both the server and the window thread can import:

   ```ts
   import { createUpdater, githubReleases, type InstallerHandoff } from "bun-app-updater";
   import { version } from "../package.json";

   // Windows: Inno Setup's flags, plus two of the app's own (see "The Windows installer" below).
   export const installer: InstallerHandoff = {
     args: ({ installDir, pid, relaunch }) => [
       "/SILENT", "/NORESTART", `/DIR=${installDir}`, `/WAITPID=${pid}`,
       ...(relaunch ? ["/RELAUNCH=1"] : []),
     ],
   };

   export const updater = createUpdater({
     appName: "MyApp",
     version,
     source: githubReleases({
       repo: "me/myapp",
       tagPrefix: "v",
       userAgent: "MyApp",
     }),
     assetName: (_version, target) =>
       target.startsWith("darwin") ? `MyApp-${target}.dmg`
       : target === "windows-x64" ? "MyApp-windows-x64-setup.exe"
       : null,
     bundleExecutable: "myapp", // macOS: the name under Contents/MacOS
     installer,
     busy: () => (jobsRunning() ? "a job is running" : null),
   });
   ```

   `busy()` is asked before the download and again before the swap (macOS) or the hand-off to
   the installer (Windows): either replaces what the app's child processes run from, so it must
   only happen on an idle app. `installing()` and `installedVersion()` let the app refuse new
   work from the moment an install starts until the restart.

3. Two routes on your `Bun.serve`, behind whatever origin check your other routes use:

   ```ts
   import { updateHttp } from "bun-app-updater";
   const http = updateHttp(updater);
   // GET  /api/update            -> http.check(req)    JSON UpdateInfo (`?force=1` re-asks the feed)
   // POST /api/update/install    -> http.install(req)  SSE stream of InstallEvent, ending in `done`
   ```

4. In `main.ts`, before the server starts:

   ```ts
   import { cleanUpAfterUpdate, finishUpdate, installTarget, waitForArg, waitForExit } from "bun-app-updater";
   const replacing = waitForArg();
   if (replacing) await waitForExit(replacing); // the copy this one replaces frees the port
   cleanUpAfterUpdate(installTarget(), { appName: "MyApp" }); // what an earlier update left behind
   ```

   At launch and nowhere else: it also removes a download folder named for this process's own
   pid, which at launch can only be an earlier process's that had the same pid. (The updater's
   `cleanUp()` does nothing once an install has started.)

   and after the window closes — whether the page asked for a restart or the user just closed it:

   ```ts
   webview.bind("__myappRestart", () => {
     restartRequested = true;
     endTheEventLoop();
   });
   // … webview.run() returns, shut down the server …
   await finishUpdate({ target: installTarget(), appName: "MyApp", installer, relaunch: restartRequested });
   process.exit(0);
   ```

   `finishUpdate` runs a staged Windows installer (told to relaunch only when the user asked),
   or on a restart starts the new copy. Await it: on macOS the relaunch goes through `open -n`,
   and if that fails it starts the executable directly, which only a process still alive to see
   `open` fail can do. If the Windows installer cannot be started, the app is started again as
   it is, so a Restart never ends with no app. `args` are passed to the new copy; `env` starts
   it directly with that environment, in this working directory, instead of through `open` —
   for a copy started from a terminal, which `open` would restart with launchd's variables and
   `/` as its folder.

   Every way the app ends has to reach `finishUpdate`, not only a closed window: a run with no
   window (headless, or a webview that would not open) ends on a signal or on a restart the page
   asks the server for, and a staged installer that is never started leaves the app refusing
   work until the next launch throws the download away.

   With webview-bun, ending the loop from a bound callback is `lib.symbols.webview_terminate(webview.unsafeHandle)`
   (`import { lib } from 'webview-bun/src/ffi'`); the class's `destroy()` would free the handle
   that `run()` frees again on return.

5. In the page: poll `GET /api/update` (on load and every half hour — the server asks the feed at
   most once per 30 minutes whatever the page does, and a failed check again after a minute),
   show `latest`, `installed` and `blocked`, stream `POST /api/update/install` and read
   `downloading` / `unpacking` for a progress bar (a `total` of 0 is a step of unknown length:
   draw it indeterminate), and on `done.ok` call the restart binding. `checkFailed` says the
   answer was no answer: ask again sooner than half an hour (backing off, so a rate-limited feed
   is not asked every minute), and with `?force=1` when the browser reports the network back —
   unforced, a check inside that minute returns the cached failure.

6. To rehearse an update with nothing published, `writeLocalFeed({ dir, version, url })` writes
   a `release.json` beside the build's downloads that `jsonRelease` reads; launch the copy to
   update with its `file:` URL as the feed (MotionBuff's `bun run update:feed` prints the line).
   The version must be higher than the copy being updated.

## The Windows installer

The app's installer has to do three things an ordinary install doesn't, and the arguments in
`InstallerHandoff` are how it is told to. With Inno Setup:

- **Wait for the old process.** `/WAITPID=<pid>` is read in `InitializeSetup` (`OpenProcess` +
  `WaitForSingleObject` from kernel32) so nothing is copied over the running executable.
- **Start the app again when asked.** A `[Run]` entry with `Check:` on `/RELAUNCH=1`; the
  ordinary `postinstall skipifsilent` entry does nothing in a silent install.
- **Remove what the new version no longer ships, without risking the old one.** `[Files]` only
  adds and overwrites, so what the build owns has to go first — but `[InstallDelete]` is not
  undone when the install fails, and an update that dies half way (a shutdown, a full disk, a
  locked file) would leave an app missing its own files. Move them aside instead
  (`CurStepChanged(ssInstall)`), delete the moved copy once the install has finished
  (`ssPostInstall`), and move it back in `DeinitializeSetup` when it has not.

`/SILENT` shows the progress window and any error, which is what a user who pressed Restart
should see; `/VERYSILENT /SUPPRESSMSGBOXES` would turn a failed install into an app that never
came back.

## The pieces

| Module        | What it does                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `version`     | strict `X.Y.Z` parse and compare                                                                                     |
| `source`      | `ReleaseSource`, `githubReleases`, `jsonRelease`, `staticRelease`                                                    |
| `target`      | `installTarget` (what is replaced), `blockedReason` (why it cannot be), `targetName`                                 |
| `download`    | stream to a `.partial` file, hash as it goes, verify size and SHA-256 (a missing checksum is refused)                |
| `swap-bundle` | mount the DMG, ditto the `.app` out, codesign verify, exchange it with the installed one atomically                  |
| `relaunch`    | `--wait-for=<pid>`, `waitForExit`, `relaunch` (`open -n` on macOS), `finishUpdate`, `cleanUpAfterUpdate`             |
| `feed`        | `writeLocalFeed`: a `release.json` of `file:` URLs over a build's downloads, for rehearsing an update                 |
| `updater`     | the facade: check cache, single-flight install, `installedVersion`, events                                           |
| `http`        | the two routes, for any `Bun.serve`                                                                                  |

`bun test ./src/` runs everything on scratch directories; the macOS swap test builds, signs and
packs a tiny real `.app` into a real disk image.
