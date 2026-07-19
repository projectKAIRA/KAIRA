import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Nav from './Nav';
import Footer from './Footer';
import Butterfly from './Butterfly';
import { useReveal } from '@/hooks/useReveal';

export default function Layout({ children }) {
  const location = useLocation();

  // Re-run scroll-reveal setup on every navigation
  useReveal(location.pathname);

  // Scroll to top on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <Nav />
      <Butterfly />
      <main className="relative z-[2] flex-1">{children}</main>
      <Footer />
    </div>
  );
}
