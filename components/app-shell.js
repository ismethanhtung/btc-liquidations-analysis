"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Database, FlaskConical, RefreshCcw, Search, Settings, Sun, Zap, Flame } from "lucide-react";
import { useEffect, useState } from "react";

const navItems = [
  { href: "/", label: "Tong quan", icon: Activity },
  { href: "/data", label: "Data", icon: Database },
  { href: "/hyperliquid-liquidation", label: "HL Liquidation", icon: Zap },
  { href: "/coinglass-liquidation", label: "Coinglass 2Y", icon: Flame },
  { href: "/analysis", label: "Phan tich", icon: FlaskConical },
  { href: "/analysis-2", label: "Phan tich 2", icon: FlaskConical },
  { href: "/analysis-3", label: "Phan tich 3", icon: FlaskConical },
  { href: "/phatich4", label: "Phan tich 4", icon: FlaskConical },
  { href: "/phatich5", label: "Phan tich 5", icon: FlaskConical },
  { href: "/settings", label: "Display", icon: Settings }
];

const themes = ["light", "light-pastel-pink", "dark1"];
const fonts = [
  { label: "Plus Jakarta Sans", key: "plus-jakarta" },
  { label: "Inter", key: "inter" },
  { label: "Outfit", key: "outfit" }
];

export function AppShell({ children }) {
  const pathname = usePathname();
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const t = localStorage.getItem("omnivideo-theme") || "light";
    const f = localStorage.getItem("omnivideo-font") || "plus-jakarta";
    document.documentElement.setAttribute("data-theme", t);
    document.documentElement.setAttribute("data-app-font", f);
    setTheme(t);
  }, []);

  function toggleTheme() {
    const idx = themes.indexOf(theme);
    const next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("omnivideo-theme", next);
    setTheme(next);
  }

  function setFont(key) {
    document.documentElement.setAttribute("data-app-font", key);
    localStorage.setItem("omnivideo-font", key);
  }

  return (
    <div className="h-screen min-h-screen flex bg-[var(--bg-main)]">
      <aside className="w-[264px] border-r border-[var(--border-color)] bg-[var(--bg-main)] flex flex-col">
        <div className="h-12 px-4 flex items-center border-b border-[var(--border-color)] text-[20px] font-semibold">BTC Lab</div>
        <div className="p-3 border-b border-[var(--border-color)]">
          <div className="input-ui flex items-center px-2 py-2 text-[11px]">
            <Search className="h-3.5 w-3.5 mr-2 text-[var(--text-muted)]" />
            <input className="bg-transparent outline-none w-full" placeholder="Search..." />
          </div>
        </div>
        <nav className="thin-scrollbar flex-1 overflow-auto p-2 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={`nav-item ${active ? "nav-item-active" : ""} flex items-center gap-2 px-3 py-2 text-[12px] font-semibold`}>
                <Icon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-[var(--border-color)] text-[10px] text-[var(--text-muted)]">v0.1.0</div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="h-12 border-b border-[var(--border-color)] bg-[var(--bg-main)] px-3 flex items-center justify-between gap-2">
          <div className="input-ui w-[280px] px-2 py-1.5 text-[11px] text-[var(--text-muted)]">Capture link / keyword...</div>
          <div className="flex items-center gap-2 text-[11px] font-semibold">
            <button className="border border-[var(--border-color)] px-3 py-1.5 bg-[var(--bg-main)]">Progress</button>
            <button className="border border-[var(--border-color)] px-3 py-1.5 bg-[var(--bg-main)]">System</button>
            <button className="border border-[var(--border-color)] px-3 py-1.5 bg-[var(--bg-main)] inline-flex items-center gap-1"><RefreshCcw className="h-3.5 w-3.5" /> Refresh</button>
            <button onClick={toggleTheme} className="border border-[var(--border-color)] px-3 py-1.5 bg-[var(--bg-main)] inline-flex items-center gap-1"><Sun className="h-3.5 w-3.5" /> {theme}</button>
            <select onChange={(e) => setFont(e.target.value)} className="input-ui px-2 py-1.5 text-[11px]">
              {fonts.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
        </header>
        <section className="flex-1 overflow-auto thin-scrollbar bg-[color-mix(in_oklab,var(--bg-secondary)_35%,white)] p-5">{children}</section>
      </main>
    </div>
  );
}
