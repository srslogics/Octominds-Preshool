import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OctoMinds | Operations Platform",
  description: "A multi-branch operations platform for preschool and daycare teams.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
