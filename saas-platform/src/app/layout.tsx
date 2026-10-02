import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PinkTree — Voice Agent Platform",
  description: "Manage AI voice agents, leads, and campaigns.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
