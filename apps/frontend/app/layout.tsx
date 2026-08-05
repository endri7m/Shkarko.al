import { Outfit, Inter } from 'next/font/google';
import './global.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
  weight: ['300', '400', '500', '600', '700', '800'],
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600'],
});

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export const metadata = {
  title: 'Shkarko.al | Konvertim Audio me Cilësi të Lartë',
  description: 'Shkarkoni dhe konvertoni video nga YouTube në MP3 me cilësi të lartë (deri në 320kbps) duke përdorur serverin tonë të shpejtë të përpunimit.',
  keywords: ['shkarko mp3', 'konvertues mp3', 'youtube ne mp3', 'shkarko nga youtube', 'Shkarko.al'],
  robots: 'index, follow',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="sq" className={`${outfit.variable} ${inter.variable}`}>
      <body className="min-h-screen bg-mesh bg-background font-sans antialiased text-gray-100 selection:bg-brand-purple/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}
