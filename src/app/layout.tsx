import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sentinel — survival analysis for leveraged crypto portfolios",
  description:
    "Sentinel measures the risk that actually liquidates leveraged crypto books: correlated simultaneous liquidation. Regime-split correlations, block-bootstrap survival simulation, a liquidation cascade map, and a ranked de-risking prescription.",
  openGraph: {
    title: "Sentinel",
    description:
      "Leveraged crypto portfolios don't die from one asset moving. They die from everything moving together. Sentinel measures that.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 text-ink-100 antialiased">
        {children}
      </body>
    </html>
  );
}
