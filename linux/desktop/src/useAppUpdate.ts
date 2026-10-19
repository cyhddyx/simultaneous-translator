import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./snapshot";
import { updateApi, type UpdateInfo, type UpdateProgress } from "./updateApi";

const AUTO_CHECK_KEY = "simultaneous-translator.auto-check-updates";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "opened";

function readAutoCheck(): boolean {
  try { return localStorage.getItem(AUTO_CHECK_KEY) !== "false"; }
  catch { return true; }
}

export function useAppUpdate() {
  const [autoCheck, setAutoCheck] = useState(readAutoCheck);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [dismissedTag, setDismissedTag] = useState<string | null>(null);
  const busy = useRef(false);
  const ready = useRef(false);
  const infoRef = useRef<UpdateInfo | null>(null);

  const check = useCallback(async () => {
    if (!updateApi.available || busy.current || ready.current) return;
    busy.current = true;
    setPhase("checking");
    setError(null);
    try {
      const result = await updateApi.check();
      infoRef.current = result;
      setInfo(result);
      setPhase(result.available ? "available" : "current");
      setCheckedAt(new Date());
    } catch (error) {
      setError(errorMessage(error, "无法检查更新，请稍后重试。"));
      setPhase(infoRef.current?.available ? "available" : "idle");
    } finally { busy.current = false; }
  }, []);

  useEffect(() => {
    if (!autoCheck || !updateApi.available) return;
    const startup = window.setTimeout(() => void check(), 2000);
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL);
    return () => { window.clearTimeout(startup); window.clearInterval(interval); };
  }, [autoCheck, check]);

  useEffect(() => {
    if (!updateApi.available) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void updateApi.subscribeProgress((event) => {
      if (event.tag === infoRef.current?.tag) setProgress(event);
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; })
      .catch(() => { /* The download still completes if progress events are unavailable. */ });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const download = async () => {
    if (busy.current || !infoRef.current?.downloadAvailable) return;
    busy.current = true;
    ready.current = false;
    setPhase("downloading");
    setProgress(null);
    setError(null);
    try {
      await updateApi.download();
      ready.current = true;
      setPhase("ready");
    } catch (error) {
      setError(errorMessage(error, "下载更新失败，请重试。"));
      setPhase("available");
    } finally { busy.current = false; }
  };

  const install = async () => {
    if (busy.current || !ready.current) return;
    busy.current = true;
    setPhase("installing");
    setError(null);
    try {
      // Linux never runs an installer from inside the app: the native side
      // verifies SHA-256 and opens the download folder (or replaces the running
      // AppImage and asks for a restart). A normal return means the update step
      // is done; no optional event is required for the UI to move on.
      await updateApi.install();
      setPhase("opened");
    }
    catch (error) {
      setError(errorMessage(error, "无法完成更新，请重试。"));
      setPhase("ready");
    } finally { busy.current = false; }
  };

  const changeAutoCheck = (enabled: boolean) => {
    try { localStorage.setItem(AUTO_CHECK_KEY, String(enabled)); } catch { /* Use the preference for this session. */ }
    setAutoCheck(enabled);
  };

  const openReleases = async () => {
    try { await updateApi.openReleases(); }
    catch (error) { setError(errorMessage(error, "无法打开 GitHub 发布页。")); }
  };

  return {
    autoCheck, phase, info, progress, error, checkedAt,
    supported: updateApi.available,
    showBanner: Boolean(info?.available && dismissedTag !== info.tag),
    changeAutoCheck, check, download, install, openReleases,
    dismiss: () => setDismissedTag(info?.tag ?? null),
  };
}

export type AppUpdateController = ReturnType<typeof useAppUpdate>;
