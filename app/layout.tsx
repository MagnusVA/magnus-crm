import type { Metadata } from "next";
import { Suspense } from "react";
import { Barlow, Barlow_Condensed, JetBrains_Mono } from "next/font/google";
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

// Barlow for text, Barlow Condensed for times, status words and figures.
const barlow = Barlow({
	variable: "--font-barlow",
	subsets: ["latin"],
	weight: ["400", "500", "600", "700"],
});

const barlowCondensed = Barlow_Condensed({
	variable: "--font-barlow-condensed",
	subsets: ["latin"],
	weight: ["500", "600", "700"],
});

// Latin subset of public/Aceh-Light.ttf as WOFF2: 25 KB instead of 168 KB.
// pyftsubset public/Aceh-Light.ttf --flavor=woff2 --layout-features='*'
//   --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+20A0-20CF,U+2122,U+2212"
const acehLight = localFont({
	src: "./fonts/Aceh-Light-latin.woff2",
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
		// The three files browsers use. next.config.ts caches them for a week.
		icon: [
			{ url: "/favicon.ico", sizes: "any" },
			{ url: "/favicon.svg", type: "image/svg+xml" },
		],
		apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
				barlow.variable,
				barlowCondensed.variable,
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
