// Studafy status page (ST-264). Vanilla JS, no framework, no build step — this file is uploaded
// directly by Terraform (status_page.tf), templated once for the subscribe endpoint's URL (empty
// wherever SES isn't wired up for this environment — see status_page.tf's header — in which case
// the subscribe section simply stays hidden).
//
// components.json is written every minute by lambda/status-page-sync; incidents.json is written by
// lambda/status-page-incident whenever someone posts a manual update. Both are same-origin fetches
// through this same CloudFront distribution — no CORS needed for either.

const SUBSCRIBE_URL = "${subscribe_url}";

// Display order and labels, independent of whatever order components.json's keys happen to
// serialize in. Matches the ticket's own component list (API, web, realtime, AI, billing).
const COMPONENT_ORDER = [
  ["api", "API"],
  ["web", "Web"],
  ["realtime", "Realtime"],
  ["ai", "AI"],
  ["billing", "Billing"],
];

const STATUS_LABELS = {
  operational: "Operational",
  major_outage: "Major outage",
};

function el(tag, props, children) {
  const node = document.createElement(tag);
  Object.assign(node, props ?? {});
  for (const child of children ?? []) node.append(child);
  return node;
}

async function fetchJson(path, fallback) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

function renderComponents(components) {
  const list = document.getElementById("components");
  list.replaceChildren();

  let anyOutage = false;
  let anyKnown = false;

  for (const [key, label] of COMPONENT_ORDER) {
    const status = components[key];
    if (status === undefined) continue; // ai stays absent from components.json wherever the
    // ai-health check hasn't been deployed yet — the badge is simply not shown rather than
    // claiming a status nothing measured.
    anyKnown = true;
    if (status === "major_outage") anyOutage = true;

    list.append(
      el("li", {}, [
        el("span", { textContent: label }),
        el("span", {
          className: `badge $${status}`,
          textContent: STATUS_LABELS[status] ?? status,
        }),
      ]),
    );
  }

  const overall = document.getElementById("overall");
  if (!anyKnown) {
    overall.textContent = "Status unavailable";
    overall.className = "overall";
  } else if (anyOutage) {
    overall.textContent = "Some systems are experiencing issues";
    overall.className = "overall major_outage";
  } else {
    overall.textContent = "All systems operational";
    overall.className = "overall operational";
  }
}

function renderIncidents(incidents) {
  const list = document.getElementById("incidents");
  list.replaceChildren();

  if (!incidents || incidents.length === 0) {
    list.append(el("li", { className: "empty", textContent: "No incidents reported." }));
    return;
  }

  for (const incident of incidents) {
    const updates = (incident.updates ?? [])
      .slice()
      .reverse()
      .map((update) =>
        el("p", { className: "update" }, [
          el("span", { className: "update-status", textContent: update.status }),
          document.createTextNode(` — $${update.body} `),
          el("span", { className: "update-time", textContent: new Date(update.postedAt).toLocaleString() }),
        ]),
      );

    list.append(
      el("li", {}, [
        el("p", { className: "incident-title", textContent: incident.title }),
        el("p", {
          className: "incident-meta",
          textContent: `Components: $${(incident.components ?? []).join(", ")} · Impact: $${incident.impact}`,
        }),
        ...updates,
      ]),
    );
  }
}

async function handleSubscribe(event) {
  event.preventDefault();
  const emailInput = document.getElementById("email");
  const message = document.getElementById("subscribe-message");
  message.textContent = "Submitting…";

  try {
    const response = await fetch(SUBSCRIBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: emailInput.value }),
    });
    const body = await response.json().catch(() => ({}));

    if (response.ok && body.status === "already_subscribed") {
      message.textContent = "You're already subscribed.";
    } else if (response.ok) {
      message.textContent = "Check your inbox to confirm your subscription.";
      emailInput.value = "";
    } else {
      message.textContent = "That didn't work — check the address and try again.";
    }
  } catch {
    message.textContent = "That didn't work — check the address and try again.";
  }
}

async function main() {
  const [componentsDoc, incidentsDoc] = await Promise.all([
    fetchJson("components.json", { components: {} }),
    fetchJson("incidents.json", { incidents: [] }),
  ]);

  renderComponents(componentsDoc.components ?? {});
  renderIncidents(incidentsDoc.incidents ?? []);

  if (SUBSCRIBE_URL) {
    document.getElementById("subscribe-section").hidden = false;
    document.getElementById("subscribe-form").addEventListener("submit", handleSubscribe);
  }
}

main();
