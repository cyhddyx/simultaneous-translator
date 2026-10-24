import { Download, ExternalLink, RefreshCw, X } from "./PixelIcons";
import { APP_VERSION } from "./updateApi";
import type { AppUpdateController } from "./useAppUpdate";

export function UpdateBanner({ update, onOpen }: { update: AppUpdateController; onOpen: () => void }) {
  if (!update.showBanner || !update.info) return null;
  return (
    <aside className="update-banner" role="status" aria-label="新版本提醒">
      <Download size={18} />
      <span><strong>发现新版本 {update.info.tag}</strong><small>
        {update.phase === "ready" ? "安装包已下载，可以安装更新。" : "软件有更新了，查看更新内容并获取新版本。"}
      </small></span>
      <button className="button button--secondary" type="button" onClick={onOpen}>查看更新</button>
      <button className="icon-button" type="button" aria-label="稍后提醒更新" onClick={update.dismiss}><X size={14} /></button>
    </aside>
  );
}

export function AppUpdateSection({ update, sessionActive, onInstall }: { update: AppUpdateController; sessionActive: boolean; onInstall: () => void }) {
  const { phase, info, error, progress } = update;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const percent = progress && progress.total > 0 ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : 0;
  const status = phase === "checking" ? "正在连接 GitHub，检查更新…"
    : phase === "downloading" ? "正在下载安装包，完成后校验文件…"
    : phase === "ready" ? "下载完成，SHA-256 校验通过。"
    : phase === "installing" ? "正在退出应用并打开安装程序…"
    : info?.available ? `发现新版本 ${info.tag}`
    : phase === "current" ? "当前已是最新版本。"
    : error ? "检查更新失败，请稍后重试。"
    : "尚未检查更新。";

  return (
    <section className="settings-section app-update-section">
      <div className="settings-section__heading">
        <Download size={18} /><div><h3>软件更新</h3><p>从 GitHub Releases 获取新版本。</p></div>
      </div>
      <div className="update-version"><strong>当前版本</strong><span>{info?.currentVersion ?? APP_VERSION}</span></div>
      <label className="toggle-row">
        <span><strong>自动检查更新</strong><small>启动后自动检查，此后每 6 小时检查一次。发现新版本时在主界面提醒；此选项立即生效。</small></span>
        <input className="switch-input" type="checkbox" checked={update.autoCheck}
          onChange={(event) => update.changeAutoCheck(event.target.checked)} />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      </label>
      <div className="update-status" role="status" aria-live="polite">
        {update.supported ? status : "请在 Windows 桌面版中检查和安装更新。"}
      </div>
      {update.checkedAt && <p className="update-detail">上次检查：{update.checkedAt.toLocaleString("zh-CN")}</p>}
      {phase === "downloading" && <div className="update-progress">
        <progress value={progress ? percent : undefined} max={100} aria-label="安装包下载进度" />
        <span>{progress ? `${percent}% · ${(progress.downloaded / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : "正在准备下载…"}</span>
      </div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="update-actions">
        <button className="button button--secondary" type="button" disabled={!update.supported || busy || phase === "ready"}
          onClick={() => void update.check()}><RefreshCw size={15} />{phase === "checking" ? "正在检查" : "检查更新"}</button>
        {info?.available && info.downloadAvailable && phase !== "ready" && phase !== "installing" && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void update.download()}>
            <Download size={15} />{phase === "downloading" ? "正在下载" : `下载更新${info.size ? `（${(info.size / 1024 / 1024).toFixed(1)} MB）` : ""}`}
          </button>
        )}
        {(phase === "ready" || phase === "installing") && (
          <button className="button button--primary" type="button" disabled={busy || sessionActive} onClick={onInstall}>
            {phase === "installing" ? "正在安装" : "退出并安装"}
          </button>
        )}
        {phase === "ready" && <button className="button button--secondary" type="button" onClick={() => void update.download()}>重新下载</button>}
        <button className="button button--secondary" type="button" onClick={() => void update.openReleases()}><ExternalLink size={15} />GitHub 发布页</button>
      </div>
      {(phase === "ready" || phase === "installing") && <p className="update-detail">
        {sessionActive ? "请先停止同传，再退出并安装更新。" : "点击“退出并安装”后应用会关闭，安装向导将打开。"}
      </p>}
      {info?.available && !info.downloadAvailable && <p className="update-detail">此版本尚未提供完整的 Windows 安装包和校验文件，请前往 GitHub 发布页获取。</p>}
      {info?.available && <div className="update-release">
        <strong>{info.title} {info.prerelease && <span className="update-detail">· 测试版</span>}</strong>
        {info.publishedAt && <p className="update-detail">发布时间：{new Date(info.publishedAt).toLocaleString("zh-CN")}</p>}
        <p className="update-notes">{info.notes || "此版本未提供更新说明。"}</p>
      </div>}
    </section>
  );
}
