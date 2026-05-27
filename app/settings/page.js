export default function SettingsPage() {
  return (
    <div className="panel-shell">
      <div className="panel-header px-5 py-4">
        <h1 className="text-[18px] font-semibold">Display</h1>
        <p className="text-[12px] text-[var(--text-muted)]">Typography + Appearance: fonts va themes.</p>
      </div>
      <div className="px-5 py-5 text-[12px] text-[var(--text-muted)]">
        Dung nut tren topbar de doi theme va font. Gia tri duoc luu vao localStorage voi key `omnivideo-theme` va `omnivideo-font`.
      </div>
    </div>
  );
}
