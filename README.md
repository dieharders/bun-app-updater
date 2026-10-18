# bun-app-updater

In-app updates for a Bun app: check a release feed, download this platform's build,
verify it, swap it in by rename, relaunch. The app supplies a config and two routes.

Its only dependency is `fflate`.

## What it assumes about the app

- A `bun build --compile` executable, installed in one of two layouts:
  - **directory** (Windows, Linux): the executable in a directory, with whatever the build
    staged beside it. The update replaces the entries the new build carries and leaves the rest
    (an installer's uninstaller, a browser profile folder) alone.
  - **bundle** (macOS): `<Name>.app/Contents/MacOS/<exe>`, codesigned. The whole `.app` is
    replaced, because replacing anything inside it breaks the seal.
- The install location is **writable by the user** (per-user installs on Windows, a dragged
  `.app` on macOS). Where it is not, `check()` says why and the app offers a download page.
- A release feed. Built in: **GitHub Releases** (listed and filtered by tag prefix — never
  `/releases/latest`, which a repo shared with another project would hijack) and a **JSON
  manifest** at any URL (for an app that hosts its own feed, and for testing against a local
  file server).
- Per platform in each release, a **manifest** named by `manifestName(version, target)` where
  `target` is `windows-x64`, `darwin-arm64`, `linux-x64`, …, and **one zip per top-level
  entry** of the install tree (`manifest.ts` has the shape). Each part records its zip's size
  and SHA-256 and a content hash of the entry (`hashTree` in `tree-hash.ts`); the updater hashes
  the installed entries and downloads only those that differ. The zips:
  - macOS: the whole `.app` as the one part — `ditto -c -k --norsrc --noextattr --keepParent
App.app out.zip` (the updater unpacks with ditto and runs `codesign --verify --deep --strict`
    before swapping). A bundle update is always the whole download: the seal covers it all.
  - Windows: `tar -a -cf out.zip -C <dir> <entry>` (bsdtar, in Windows 10 since 1803), one entry
    per zip
  - Linux: `cd <dir> && zip -r -y out.zip <entry>` (`-y` keeps symlinks; exec bits are read back
    from the zip's central directory and restored)

  The manifest is verified against the **digest the feed lists for it** (GitHub computes one for
  every asset); a manifest with no digest is refused, never installed on trust. The parts are
  verified against the manifest's SHA-256s, and against the feed's digests too when it lists
  them.

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
   `fflate`, its one dependency, is installed with it.

3. Import it by name, including the subpaths:

   ```ts
   import { createUpdater, githubReleases } from "bun-app-updater";
   import { writeUpdateParts } from "bun-app-updater/parts";
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
`WritePartsOptions` and the manifest format — are versioned in `package.json`; a manifest
format change also bumps `MANIFEST_FORMAT`, and an installed copy refuses a manifest of another
format with a plain message rather than misreading it. So a format bump ships behind a release
of the old format that already carries the new reader.

Without a workspace, the same thing works with a path dependency
(`"bun-app-updater": "file:./vendor/bun-app-updater"`) or by copying the folder in and running
`bun add fflate`; the submodule is what keeps every app on one source.

## Dropping it into an app

1. Install it as above.
2. Configure it once, somewhere both the server and the window thread can import:

   ```ts
   import { createUpdater, githubReleases } from "bun-app-updater";
   import { version } from "../package.json";

   export const updater = createUpdater({
     appName: "MyApp",
     version,
     source: githubReleases({
       repo: "me/myapp",
       tagPrefix: "v",
       userAgent: "MyApp",
     }),
     manifestName: (v, target) => `MyApp-${v}-${target}.manifest.json`,
     bundleExecutable: "myapp", // macOS: the name under Contents/MacOS
     busy: () => (jobsRunning() ? "a job is running" : null),
   });
   ```

   `busy()` is asked before the download and again before the swap: the swap moves the
   directories the app's child processes run from, so it must only happen on an idle app.

3. Two routes on your `Bun.serve`, behind whatever origin check your other routes use:

   ```ts
   import { updateHttp } from "bun-app-updater";
   const http = updateHttp(updater);
   // GET  /api/update            -> http.check(req)    JSON UpdateInfo (`?force=1` re-asks the feed)
   // POST /api/update/install    -> http.install(req)  SSE stream of InstallEvent, ending in `done`
   ```

4. In `main.ts`, before the server starts:

   ```ts
   import {
     cleanUpAfterUpdate,
     relaunch,
     waitForArg,
     waitForExit,
   } from "bun-app-updater";
   const replacing = waitForArg();
   if (replacing) await waitForExit(replacing); // the copy this one replaces frees the port
   cleanUpAfterUpdate(updater.target()); // Windows: the old exe could not be deleted while it ran
   ```

   and after the window closes, if the page asked for a restart:

   ```ts
   webview.bind("__myappRestart", () => {
     restartRequested = true;
     endTheEventLoop();
   });
   // … webview.run() returns, shut down the server …
   if (restartRequested) updater.relaunch();
   process.exit(0);
   ```

   With webview-bun, ending the loop from a bound callback is `lib.symbols.webview_terminate(webview.unsafeHandle)`
   (`import { lib } from 'webview-bun/src/ffi'`); the class's `destroy()` would free the handle
   that `run()` frees again on return.

5. In the page: poll `GET /api/update` (on load and every few hours — the server asks the feed at
   most once per 30 minutes whatever the page does), show `latest`, `installed` and `blocked`,
   stream `POST /api/update/install` and read `downloading` / `unpacking` for a progress bar,
   and on `done.ok` call the restart binding. `latest.size` is what the install will download
   (the stale parts, not the release), and `latest.parts` names them.

6. At build time, write the parts and the manifest with `writeUpdateParts` (`parts.ts`), from
   the staged install tree:

   ```ts
   import { writeUpdateParts } from "bun-app-updater";
   await writeUpdateParts({
     sourceDir: "dist/native",
     outDir: "dist/update",
     version,
     target,
     platform: process.platform,
     manifestName: `MyApp-${version}-${target}.manifest.json`,
     partName: (entry) => `MyApp-${version}-${target}-${entry}.zip`,
     bundle: "MyApp.app", // macOS only: the one part
     required: ["myapp", "vendor"], // an incomplete build fails here
     executables: ["vendor/ffmpeg"], // Linux: must be recorded as executable
   });
   ```

   It runs the platform's archiver, then reads every part back with this package's own
   reader, unpacks it the way the updater does and checks the content hash — a part whose
   unpacked hash differed from the manifest's would be downloaded on every update forever, and
   that is caught on the build machine. Publish everything in `outDir`.

7. To rehearse an update with nothing published, `writeLocalFeed({ dir: outDir, url })` writes
   a `release.json` beside the parts that `jsonRelease` reads, and launch the copy to update
   with its `file:` URL as the feed (MotionBuff's `bun run update:feed` prints the line). The
   parts must be a higher version than the copy being updated.

## The pieces

| Module           | What it does                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `version`        | strict `X.Y.Z` parse and compare                                                                                       |
| `source`         | `ReleaseSource`, `githubReleases`, `jsonRelease`, `staticRelease`                                                      |
| `target`         | `installTarget` (what is replaced), `blockedReason` (why it cannot be), `targetName`                                   |
| `manifest`       | the release's manifest: one part per top-level entry, with sizes, SHA-256s and content hashes                          |
| `tree-hash`      | `hashTree`: one SHA-256 for a file or a directory's content, the same wherever it sits                                 |
| `parts`          | `writeUpdateParts`: the build side — archive each entry, write the manifest, read it all back                          |
| `feed`           | `writeLocalFeed`: a `release.json` of `file:` URLs over those parts, for rehearsing an update with nothing published   |
| `download`       | stream to a `.partial` file, hash as it goes, verify size and SHA-256 (a missing checksum is refused)                  |
| `zip`            | streaming unpack (fflate), a central-directory reader for modes and symlinks, unsafe-path refusal                      |
| `swap-directory` | unpack the parts into `.update-new/`, move entries aside into `.update-old/`, new ones in, roll back on failure        |
| `swap-bundle`    | ditto, codesign verify, rename the `.app`                                                                              |
| `relaunch`       | `--wait-for=<pid>`, `waitForExit`, `relaunch` (`open -n` on macOS), `cleanUpAfterUpdate`                               |
| `updater`        | the facade: check cache, the per-release plan (which parts, how many bytes), single-flight, `installedVersion`, events |
| `http`           | the two routes, for any `Bun.serve`                                                                                    |

`bun test ./src/` runs everything on scratch directories; the macOS bundle swap test builds and
signs a tiny real `.app`.
