import { Download, ExternalLink, RefreshCw, X } from "./PixelIcons";
import { APP_VERSION } from "./updateApi";
import type { AppUpdateController } from "./useAppUpdate";

export function UpdateBanner({ update, onOpen }: { update: AppUpdateController; onOpen: () => void }) {
  if (!update.showBanner || !update.info) return null;
  return (
    <aside className="update-banner" role="status" aria-label="新版本提醒">
      <Download size={18} />
      <span><strong>发现新版本 {update.info.tag}</strong><small>
        {update.phase === "ready" ? "更新包已下载，SHA-256 校验通过。" : "软件有更新了，查看更新内容并获取新版本。"}
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
    : phase === "downloading" ? "正在下载更新包，下载后校验 SHA-256…"
    : phase === "ready" ? "下载完成，SHA-256 校验通过。"
    : phase === "installing" ? "正在校验更新包并打开下载目录…"
    : phase === "opened" ? "已校验更新包并打开下载目录；若为 AppImage，替换后重启应用即可完成更新。"
    : info?.available ? `发现新版本 ${info.tag}`
    : phase === "current" ? "当前已是最新版本。"
    : "尚未检查更新。";

  return (
    <section className="settings-section app-update-section">
      <div className="settings-section__heading">
        <Download size={18} /><div><h3>软件更新</h3><p>从 GitHub Releases 获取 Linux 安装包（deb / rpm / AppImage）。</p></div>
      </div>
      <div className="update-version"><strong>当前版本</strong><span>{info?.currentVersion ?? APP_VERSION}</span></div>
      <label className="toggle-row">
        <span><strong>自动检查更新</strong><small>启动后自动检查，此后每 6 小时检查一次。发现新版本时在主界面提醒；此选项立即生效。</small></span>
        <input className="switch-input" type="checkbox" checked={update.autoCheck}
          onChange={(event) => update.changeAutoCheck(event.target.checked)} />
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      </label>
      <div className="update-status" role="status" aria-live="polite">
        {update.supported ? status : "请在 Linux 桌面版中检查和安装更新。"}
      </div>
      {update.checkedAt && <p className="update-detail">上次检查：{update.checkedAt.toLocaleString("zh-CN")}</p>}
      {phase === "downloading" && <div className="update-progress">
        <progress value={progress ? percent : undefined} max={100} aria-label="更新包下载进度" />
        <span>{progress ? `${percent}% · ${(progress.downloaded / 1024 / 1024).toFixed(1)} / ${(progress.total / 1024 / 1024).toFixed(1)} MB` : "正在准备下载…"}</span>
      </div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="update-actions">
        <button className="button button--secondary" type="button" disabled={!update.supported || busy || phase === "ready" || phase === "opened"}
          onClick={() => void update.check()}><RefreshCw size={15} />{phase === "checking" ? "正在检查" : "检查更新"}</button>
        {info?.available && info.downloadAvailable && phase !== "ready" && phase !== "installing" && phase !== "opened" && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void update.download()}>
            <Download size={15} />{phase === "downloading" ? "正在下载" : `下载更新${info.size ? `（${(info.size / 1024 / 1024).toFixed(1)} MB）` : ""}`}
          </button>
        )}
        {(phase === "ready" || phase === "installing") && (
          <button className="button button--primary" type="button" disabled={busy} onClick={onInstall}>
            {phase === "installing" ? "正在打开…" : "打开下载目录"}
          </button>
        )}
        {phase === "opened" && (
          <button className="button button--secondary" type="button" onClick={onInstall}>再次打开下载目录</button>
        )}
        {phase === "ready" && <button className="button button--secondary" type="button" onClick={() => void update.download()}>重新下载</button>}
        <button className="button button--secondary" type="button" onClick={() => void update.openReleases()}><ExternalLink size={15} />GitHub 发布页</button>
      </div>
      {(phase === "ready" || phase === "installing" || phase === "opened") && <p className="update-detail">
        {phase === "opened"
          ? "已打开下载目录：deb / rpm 请使用系统软件包管理器安装；AppImage 若已原地替换，重启应用即可完成更新。"
          : sessionActive
            ? "同传进行中也可以下载和打开安装包，翻译不会中断；安装完成后请重启应用。"
            : "点击“打开下载目录”后在文件管理器中安装：deb / rpm 使用系统软件包管理器，AppImage 可直接替换当前文件并重启应用。"}
      </p>}
      {info?.available && !info.downloadAvailable && <p className="update-detail">此版本尚未提供 Linux 安装包（deb / rpm / AppImage）和校验文件，请前往 GitHub 发布页获取。</p>}
      {info?.available && <div className="update-release">
        <strong>{info.title} {info.prerelease && <span className="update-detail">· 测试版</span>}</strong>
        {info.publishedAt && <p className="update-detail">发布时间：{new Date(info.publishedAt).toLocaleString("zh-CN")}</p>}
        <p className="update-notes">{info.notes || "此版本未提供更新说明。"}</p>
      </div>}
    </section>
  );
}
