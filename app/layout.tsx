import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const jetbrainsMono = JetBrains_Mono({
	subsets: ["latin"],
	variable: "--font-mono",
});

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const acehLight = localFont({
	src: "../public/Aceh-Light.ttf",
	variable: "--font-aceh",
	weight: "300",
	style: "normal",
	display: "swap",
});

export const metadata: Metadata = {
	applicationName: "MAGNUS CRM",
	title: {
		default: "MAGNUS CRM",
		template: "%s | MAGNUS CRM",
	},
	description: "Tenant onboarding and appointment operations control plane.",
	icons: {
		icon: [
			{ url: "/favicon.ico", sizes: "any" },
			{ url: "/favicon.svg", type: "image/svg+xml" },
			{ url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
			{ url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
			{ url: "/favicon-48x48.png", sizes: "48x48", type: "image/png" },
			{ url: "/favicon-192x192.png", sizes: "192x192", type: "image/png" },
			{ url: "/favicon-512x512.png", sizes: "512x512", type: "image/png" },
		],
		apple: [
			{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
			{ url: "/favicon-180x180.png", sizes: "180x180", type: "image/png" },
		],
		shortcut: ["/favicon.ico"],
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			suppressHydrationWarning
			className={cn(
				"h-full",
				"antialiased",
				geistSans.variable,
				jetbrainsMono.variable,
				acehLight.variable,
				"font-sans",
			)}
		>
			{/* <head>
				<Script
					src="//unpkg.com/react-scan/dist/auto.global.js"
					crossOrigin="anonymous"
					strategy="beforeInteractive"
				/>
			</head> */}
			<body className="min-h-full flex flex-col">
				<Suspense>
					<ConvexClientProvider>
						<ThemeProvider
							attribute="class"
							defaultTheme="light"
							enableSystem={false}
							storageKey="theme-preference"
						>
							<TooltipProvider>{children}</TooltipProvider>
							<Toaster />
						</ThemeProvider>
					</ConvexClientProvider>
				</Suspense>
			</body>
		</html>
	);
}
