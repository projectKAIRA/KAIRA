export default function Privacy() {
  return (
    <section className="mesh-bg">
      <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
        <p className="hud-label mb-3">LEGAL · PRIVACY</p>
        <h1 className="text-4xl font-bold tracking-tight text-ink md:text-5xl">Privacy policy</h1>
        <p className="mt-3 text-sm text-ink-muted">Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

        <div className="prose-invert mt-10 space-y-6 text-ink-soft">
          <p>Kaira designs, builds, and maintains websites for local businesses. We take privacy seriously. This page explains what information we collect, how we use it, and your choices.</p>

          <div>
            <h2 className="text-xl font-semibold text-ink">What we collect</h2>
            <p className="mt-2">When you submit our contact form, we collect the name, business name, email, phone (optional), current website (optional), services of interest, budget range (optional), and project details you provide. We may also collect basic technical data like IP address and user agent for security and abuse prevention.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">How we use it</h2>
            <p className="mt-2">We use the information you submit solely to reply to your inquiry and provide the services you request. We do not sell, rent, or trade personal data with third parties.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Service providers</h2>
            <p className="mt-2">We use Cloudflare Turnstile to protect our forms from abuse. We may use email delivery providers to send responses. These providers process only the data required to deliver their service.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Retention</h2>
            <p className="mt-2">We retain form submissions as long as we're actively communicating with you and for a reasonable period afterward. Contact us to have your data removed at any time.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Contact</h2>
            <p className="mt-2">Questions? Reach out to <a href="mailto:hi@trykaira.ai" className="text-purple hover:underline">hi@trykaira.ai</a>.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
