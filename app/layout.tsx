import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
	title: "MAGNUS CRM",
	description: "Tenant onboarding and appointment operations control plane.",
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
				"font-sans",
			)}
		>
			<body className="min-h-full flex flex-col">
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					enableSystem={false}
					storageKey="theme-preference"
				>
					<TooltipProvider>
						<ConvexClientProvider>{children}</ConvexClientProvider>
					</TooltipProvider>
					<Toaster />
				</ThemeProvider>
			</body>
		</html>
	);
}
