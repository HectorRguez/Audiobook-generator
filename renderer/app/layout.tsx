import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Audiobook Generator",
  description: "EPUB to audiobook desktop pipeline",
  icons: {
    icon: "/app-icon.png",
    shortcut: "/app-icon.png",
    apple: "/app-icon.png"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
