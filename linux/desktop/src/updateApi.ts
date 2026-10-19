import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import packageInfo from "../package.json";

export const APP_VERSION = packageInfo.version;
export const RELEASES_URL = "https://github.com/cyhddyx/simultaneous-translator/releases";

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  tag: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  prerelease: boolean;
  available: boolean;
  downloadAvailable: boolean;
  size: number;
}

export interface UpdateProgress {
  tag: string;
  downloaded: number;
  total: number;
}

const native = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const updateApi = {
  available: native,
  check: () => invoke<UpdateInfo>("check_app_update"),
  download: () => invoke<void>("download_app_update"),
  install: () => invoke<void>("install_app_update"),
  subscribeProgress: (callback: (progress: UpdateProgress) => void) =>
    listen<UpdateProgress>("app-update-progress", (event) => callback(event.payload)),
  async openReleases(): Promise<void> {
    if (native) await invoke("open_app_releases");
    else window.open(RELEASES_URL, "_blank", "noopener,noreferrer");
  },
};
