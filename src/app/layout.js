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
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#6366f1",
          colorBackground: "#09090b",
          colorInputBackground: "#18181b",
          colorInputText: "#ffffff",
          colorText: "#ffffff",
          colorTextSecondary: "#a1a1aa",
          // Light value: used for menu actions, icons, and input borders
          colorNeutral: "#e4e4e7",
          borderRadius: "0.75rem",
        },
        elements: {
          card: "bg-zinc-950 border border-white/10 shadow-[0_0_40px_rgba(99,102,241,0.2)]",
          headerTitle: "text-white",
          headerSubtitle: "text-zinc-400",
          socialButtonsBlockButton:
            "border border-white/10 bg-zinc-900 text-white hover:bg-zinc-800",
          formButtonPrimary:
            "bg-gradient-to-r from-indigo-500 to-violet-500 hover:brightness-110",
          footerActionLink: "text-indigo-300 hover:text-indigo-200",
          userButtonPopoverActionButton: "text-white hover:bg-white/5",
          userButtonPopoverActionButtonText: "text-white",
          userButtonPopoverActionButtonIcon: "text-zinc-300",
          otpCodeFieldInput:
            "border border-white/30 text-white bg-zinc-900 focus:border-indigo-400",
        },
      }}
    >
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
