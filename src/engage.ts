// Weave API Evangelist governance services into the app. Every action routes to
// info@apievangelist.com over a mailto link, with the current context pre-filled
// — so engagement works even in a forked or fully local copy, with no backend.
// Spotlight is free, open tooling; API Evangelist sells the expert
// services around it, and this is the always-present front door to them.
const EMAIL = 'info@apievangelist.com';
const APP = 'the Spotlight Validator';
const SERVICES_URL = 'https://apievangelist.com/services/';

interface Service {
  title: string;
  blurb: string;
  cta: string;
  subject: string;
  url: string; // API Evangelist service detail page
  body: (ctx: string) => string;
}

// Mirrors the API Evangelist governance + discovery services
// (apievangelist.com/services/), scoped to what a validator user wants.
const SERVICES: Service[] = [
  {
    title: 'Reviews',
    blurb: 'Formal reviews of your API artifacts, and of the policies, rules, pipelines, and skills that govern your operations — against best practices, OWASP, and your own standards.',
    cta: 'Request a review',
    url: `${SERVICES_URL}governance/reviews/`,
    subject: 'API governance review request',
    body: (ctx) => `Hi API Evangelist,\n\nI'd like a governance review of an API artifact (and/or the rules and pipelines around it).\n\n${ctx}\n\nI'll attach or paste the artifact in my reply — what does an engagement look like?\n\nThanks,`,
  },
  {
    title: 'Rules',
    blurb: 'Encode your organization’s standards as portable, machine-readable Spectral rules you can run in CI, the editor, and the browser.',
    cta: 'Talk rulesets',
    url: `${SERVICES_URL}governance/rules/`,
    subject: 'Custom ruleset engagement',
    body: (ctx) => `Hi API Evangelist,\n\nWe’d like custom Spectral rulesets that encode our API standards.\n\n${ctx}\n\nThanks,`,
  },
  {
    title: 'Reusability',
    blurb: 'Measure how reusable your APIs actually are — score the estate against a weighted rubric, surface the duplication, and decide what to consolidate on.',
    cta: 'Assess reuse',
    url: `${SERVICES_URL}governance/reusability/`,
    subject: 'API reusability assessment',
    body: (ctx) => `Hi API Evangelist,\n\nWe’d like to assess how reusable our API estate is — scoring, duplication detection, and canonical selection.\n\n${ctx}\n\nThanks,`,
  },
  {
    title: 'Pipelines',
    blurb: 'Stand up the CI/CD pipelines that automate integration and deployment — including running these governance rules as a gate in CI.',
    cta: 'Automate governance',
    url: `${SERVICES_URL}governance/pipelines/`,
    subject: 'API governance pipelines engagement',
    body: (ctx) => `Hi API Evangelist,\n\nWe’d like to automate our API governance in CI/CD pipelines.\n\n${ctx}\n\nThanks,`,
  },
  {
    title: 'Skills',
    blurb: 'Define and iterate on the agent skills you need to operate your business with both human and programmatic resources.',
    cta: 'Build skills',
    url: `${SERVICES_URL}governance/skills/`,
    subject: 'Agent skills engagement',
    body: (ctx) => `Hi API Evangelist,\n\nWe’d like help defining and governing agent skills for our operations.\n\n${ctx}\n\nThanks,`,
  },
  {
    title: 'Standards',
    blurb: 'Identify and develop the standards required to keep every aspect of your API operations interoperable.',
    cta: 'Develop standards',
    url: `${SERVICES_URL}discovery/standards/`,
    subject: 'API standards engagement',
    body: (ctx) => `Hi API Evangelist,\n\nWe’d like help identifying and developing the standards our API operations need.\n\n${ctx}\n\nThanks,`,
  },
];

function mailto(s: Service, ctx: string): string {
  const body = `${s.body(ctx)}\n\n— sent from ${APP} (validator.spotlight-rules.com)`;
  return `mailto:${EMAIL}?subject=${encodeURIComponent(s.subject)}&body=${encodeURIComponent(body)}`;
}

// context: () => a short, plain-text summary of what the user is looking at, woven
// into the review email so the engagement starts with real detail.
export function initEngage(context: () => string): void {
  const btn = document.getElementById('engage-ae');
  if (!btn) return;

  const modal = document.createElement('div');
  modal.className = 'modal engage-modal';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="modal-card engage-card">
      <div class="modal-head">
        <span id="modal-title">Work with API Evangelist</span>
        <button type="button" class="engage-close" aria-label="Close">×</button>
      </div>
      <div class="engage-body">
        <p class="engage-intro">Spotlight Validator is open and free to run yourself. When you want experts in the loop,
          <a href="https://apievangelist.com" target="_blank" rel="noopener">API Evangelist</a> offers governance
          services — every option below opens an email to
          <a id="engage-email" href="mailto:${EMAIL}">${EMAIL}</a> with your current context filled in.</p>
        <div class="engage-services"></div>
        <p class="engage-foot"><a href="${SERVICES_URL}" target="_blank" rel="noopener">See all governance services →</a></p>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const listEl = modal.querySelector('.engage-services') as HTMLElement;
  const emailEl = modal.querySelector('#engage-email') as HTMLAnchorElement;
  const close = () => { modal.hidden = true; };

  function render(): void {
    const ctx = context();
    listEl.innerHTML = SERVICES.map((s, i) => `
      <div class="engage-service">
        <div class="engage-service-text"><strong>${s.title}</strong><span>${s.blurb}</span>
          <a class="engage-details" href="${s.url}" target="_blank" rel="noopener">details ↗</a></div>
        <a class="engage-cta" href="${mailto(s, ctx)}" data-i="${i}">${s.cta}</a>
      </div>`).join('');
    emailEl.href = mailto(SERVICES[0], ctx);
  }

  btn.addEventListener('click', () => { render(); modal.hidden = false; });
  modal.querySelector('.engage-close')!.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
