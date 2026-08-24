import { ClerkProvider } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "Short Clips — Automate Your Social Growth",
  description:
    "Generate viral short-form videos in seconds with AI scripting, kinetic captions, and cloud rendering.",
};

export default function RootLayout({ children }) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full dark antialiased`}
      >
        <body className="min-h-full flex flex-col bg-zinc-950 text-white">
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
