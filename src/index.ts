export { compareVersions, parseVersion } from './version'
export { ReleaseFeedError, githubReleases, jsonRelease, staticRelease, type Fetch, type Release, type ReleaseAsset, type ReleaseSource } from './source'
export { blockedReason, freeBytes, installTarget, targetName, type InstallTarget, type Layout } from './target'
export { UpdateError, type InstallErrorCode } from './errors'
export { downloadTo } from './download'
export { writeLocalFeed, type WriteFeedOptions, type WrittenFeed } from './feed'
export { applyBundleUpdate, exchangePaths } from './swap-bundle'
export {
  cleanUpAfterUpdate,
  finishUpdate,
  isAlive,
  pendingInstaller,
  relaunch,
  resumeStagedInstall,
  stageDir,
  waitForArg,
  waitForExit,
  WAIT_FOR_FLAG,
  type FinishOptions,
  type InstallerHandoff,
  type PendingInstaller,
  type ResumeOptions,
} from './relaunch'
export { createUpdater, type InstallEvent, type InstallEventSink, type UpdateInfo, type Updater, type UpdaterConfig } from './updater'
export { updateHttp, SSE_HEADERS, type UpdateHttp } from './http'
