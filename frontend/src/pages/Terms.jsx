export default function Terms() {
  return (
    <section className="mesh-bg">
      <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
        <p className="hud-label mb-3">LEGAL · TERMS</p>
        <h1 className="text-4xl font-bold tracking-tight text-ink md:text-5xl">Terms of service</h1>
        <p className="mt-3 text-sm text-ink-muted">Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>

        <div className="mt-10 space-y-6 text-ink-soft">
          <p>These terms govern your use of the Kaira website (trykaira.ai) and any services provided by Kaira. By using our site or engaging our services, you agree to these terms.</p>

          <div>
            <h2 className="text-xl font-semibold text-ink">Services</h2>
            <p className="mt-2">Kaira provides website design, development, SEO, and ongoing maintenance services. Specific deliverables, timelines, and pricing are agreed to in writing before any work begins.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Ownership</h2>
            <p className="mt-2">Upon full payment, you own the final website content and design deliverables specific to your project. Kaira retains ownership of any pre-existing tools, frameworks, or components used to build your site.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Warranty &amp; liability</h2>
            <p className="mt-2">We provide services "as is" without warranty of any kind. Kaira's liability is limited to the total fees paid for the specific service giving rise to the claim.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Changes</h2>
            <p className="mt-2">We may update these terms from time to time. Continued use of the site after changes means you accept the updated terms.</p>
          </div>

          <div>
            <h2 className="text-xl font-semibold text-ink">Contact</h2>
            <p className="mt-2">For questions about these terms, email <a href="mailto:hi@trykaira.ai" className="text-purple hover:underline">hi@trykaira.ai</a>.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
