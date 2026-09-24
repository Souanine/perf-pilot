export interface ScriptTemplate {
  id: string;
  name: string;
  description: string;
  /** A short hint shown next to the template name */
  tag: string;
  build: (name: string) => string;
}

const header = (name: string, purpose: string) =>
  `// ${name}\n// ${purpose}\n`;

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    id: "smoke",
    name: "Smoke test",
    tag: "5 VUs · 30s",
    description: "Tiny, constant load — sanity check before anything bigger.",
    build: (name) =>
      header(
        name,
        "Smoke test — 5 constant VUs for 30s against a single endpoint.",
      ) +
      `
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 5,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.k6.io";

export default function () {
  const res = http.get(\`\${BASE_URL}/public/crocodiles/\`);
  check(res, {
    "status is 200": (r) => r.status === 200,
  });
  sleep(1);
}
`,
  },
  {
    id: "load",
    name: "Load test (ramping)",
    tag: "0→50 VUs · 5m",
    description: "Stepwise ramp-up to validate baseline capacity.",
    build: (name) =>
      header(
        name,
        "Load test — ramp from 0 to 50 VUs over 5 minutes, then hold.",
      ) +
      `
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 10 },
    { duration: "3m", target: 50 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.k6.io";

export default function () {
  const res = http.get(\`\${BASE_URL}/public/crocodiles/\`);
  check(res, { "status is 200": (r) => r.status === 200 });
  sleep(1);
}
`,
  },
  {
    id: "spike",
    name: "Spike test",
    tag: "0→200 VUs · 5s",
    description: "Sudden traffic surge to test elasticity and recovery.",
    build: (name) =>
      header(
        name,
        "Spike test — ramp from 0 to 200 VUs in 5s, hold 30s, ramp down.",
      ) +
      `
import http from "k6/http";
import { check } from "k6";

export const options = {
  stages: [
    { duration: "5s", target: 200 },
    { duration: "30s", target: 200 },
    { duration: "5s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.k6.io";

export default function () {
  const res = http.get(\`\${BASE_URL}/public/crocodiles/\`);
  check(res, { "status is 2xx": (r) => r.status >= 200 && r.status < 300 });
}
`,
  },
  {
    id: "stress",
    name: "Stress test",
    tag: "0→300 VUs · 10m",
    description: "Push past expected capacity to find the breaking point.",
    build: (name) =>
      header(
        name,
        "Stress test — push to 300 VUs, then ramp down. Look for failure rate climbing.",
      ) +
      `
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "1m", target: 50 },
    { duration: "3m", target: 150 },
    { duration: "3m", target: 300 },
    { duration: "2m", target: 300 },
    { duration: "1m", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.10"],
    http_req_duration: ["p(99)<2000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.k6.io";

export default function () {
  const res = http.get(\`\${BASE_URL}/public/crocodiles/\`);
  check(res, { "status is 200": (r) => r.status === 200 });
  sleep(0.5);
}
`,
  },
  {
    id: "soak",
    name: "Soak test",
    tag: "20 VUs · 30m",
    description: "Sustained low load over a long period to detect memory leaks.",
    build: (name) =>
      header(
        name,
        "Soak test — 20 VUs for 30 minutes to detect slow memory or resource leaks.",
      ) +
      `
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 20,
  duration: "30m",
  thresholds: {
    http_req_failed: ["rate<0.005"],
    http_req_duration: ["p(95)<400"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.k6.io";

export default function () {
  const res = http.get(\`\${BASE_URL}/public/crocodiles/\`);
  check(res, { "status is 200": (r) => r.status === 200 });
  sleep(2);
}
`,
  },
  {
    id: "api-mix",
    name: "API mix (auth + CRUD)",
    tag: "Bearer · 4 endpoints",
    description: "Realistic API workflow: login, list, fetch, create.",
    build: (name) =>
      header(
        name,
        "API mix — auth, list, fetch, create. Uses __ENV.TOKEN and __ENV.BASE_URL.",
      ) +
      `
import http from "k6/http";
import { check, group, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "https://api.example.com";
const TOKEN = __ENV.TOKEN || "";

export const options = {
  scenarios: {
    browse: {
      executor: "constant-vus",
      vus: 10,
      duration: "1m",
      exec: "browseFlow",
    },
    write: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 4,
      exec: "writeFlow",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:browse}": ["p(95)<400"],
    "http_req_duration{scenario:write}": ["p(95)<700"],
  },
};

function authHeaders() {
  return TOKEN ? { headers: { Authorization: \`Bearer \${TOKEN}\` } } : {};
}

export function browseFlow() {
  group("browse", function () {
    const list = http.get(\`\${BASE_URL}/items\`, authHeaders());
    check(list, { "list 200": (r) => r.status === 200 });
    const items = list.json();
    if (items && items.length) {
      const detail = http.get(\`\${BASE_URL}/items/\${items[0].id}\`, authHeaders());
      check(detail, { "detail 200": (r) => r.status === 200 });
    }
    sleep(1);
  });
}

export function writeFlow() {
  group("write", function () {
    const body = JSON.stringify({ name: "perf-pilot item" });
    const params = { headers: { "content-type": "application/json" } };
    const created = http.post(\`\${BASE_URL}/items\`, body, params);
    check(created, { "created 2xx": (r) => r.status >= 200 && r.status < 300 });
  });
}
`,
  },
];

export function getTemplate(id: string): ScriptTemplate | undefined {
  return SCRIPT_TEMPLATES.find((t) => t.id === id);
}