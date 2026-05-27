import "./globals.css";
import { Plus_Jakarta_Sans, Inter, Outfit } from "next/font/google";
import { AppShell } from "@/components/app-shell";

const plusJakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });

export const metadata = {
  title: "BTC Liquidation Lab",
  description: "Nghien cuu tin hieu thanh ly long BTC"
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi" data-theme="light" data-app-font="plus-jakarta">
      <body className={`${plusJakarta.variable} ${inter.variable} ${outfit.variable} antialiased`}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
