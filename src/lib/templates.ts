/**
 * k6 script templates surfaced from the "From template" picker.
 *
 * The displayed name and description are i18n keys (`templates.<id>.name` /
 * `templates.<id>.description` / `templates.<id>.header`) so the picker
 * automatically renders in the active locale. The `tag` is a load-profile
 * summary (e.g. "5 VUs · 30s") that's meaningful in both languages and
 * therefore stays untranslated.
 *
 * To add a template:
 *   1. add an entry here with a unique `id`, a `nameKey`, a `descriptionKey`,
 *      a `tag`, and a `build(name)` that returns the full k6 source;
 *   2. add the matching `templates.<id>.name` / `description` / `header`
 *      strings in BOTH `src/i18n/en.ts` and `src/i18n/zh-CN.ts`.
 *
 * The vitest suite asserts that every template has all three keys in
 * both locales, so a missing translation will fail the build.
 */
export interface ScriptTemplate {
  id: string;
  nameKey: string;
  descriptionKey: string;
  headerKey: string;
  /** Short load-profile summary shown next to the name (not localized). */
  tag: string;
  /** Generates the full k6 source. `name` is the script's display name. */
  build: (name: string) => string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  // ----------------------------------------------------------------- basics
  {
    id: "smoke",
    nameKey: "templates.smoke.name",
    descriptionKey: "templates.smoke.description",
    headerKey: "templates.smoke.header",
    tag: "5 VUs · 30s",
    build: (name) =>
      `// ${name}
// 冒烟测试 — 5 个恒定 VU 持续 30 秒，仅命中一个端点。

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
    "状态码 200": (r) => r.status === 200,
  });
  sleep(1);
}
`,
  },
  {
    id: "load",
    nameKey: "templates.load.name",
    descriptionKey: "templates.load.description",
    headerKey: "templates.load.header",
    tag: "0→50 VUs · 5m",
    build: (name) =>
      `// ${name}
// 负载测试 — 5 分钟内从 0 平滑加压到 50 VU，用于验证基线容量。

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
  check(res, { "状态码 200": (r) => r.status === 200 });
  sleep(1);
}
`,
  },
  {
    id: "spike",
    nameKey: "templates.spike.name",
    descriptionKey: "templates.spike.description",
    headerKey: "templates.spike.header",
    tag: "0→200 VUs · 5s",
    build: (name) =>
      `// ${name}
// 峰值测试 — 5 秒内冲到 200 VU 维持 30 秒再回落，检验弹性和恢复能力。

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
  check(res, { "状态码 2xx": (r) => r.status >= 200 && r.status < 300 });
}
`,
  },
  {
    id: "stress",
    nameKey: "templates.stress.name",
    descriptionKey: "templates.stress.description",
    headerKey: "templates.stress.header",
    tag: "0→300 VUs · 10m",
    build: (name) =>
      `// ${name}
// 压力测试 — 推到 300 VU 再回落，定位系统极限与失败率拐点。

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
  check(res, { "状态码 200": (r) => r.status === 200 });
  sleep(0.5);
}
`,
  },
  {
    id: "soak",
    nameKey: "templates.soak.name",
    descriptionKey: "templates.soak.description",
    headerKey: "templates.soak.header",
    tag: "20 VUs · 30m",
    build: (name) =>
      `// ${name}
// 浸泡测试 — 20 VU 持续 30 分钟，检测慢速内存/资源泄漏。

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
  check(res, { "状态码 200": (r) => r.status === 200 });
  sleep(2);
}
`,
  },
  {
    id: "api-mix",
    nameKey: "templates.api-mix.name",
    descriptionKey: "templates.api-mix.description",
    headerKey: "templates.api-mix.header",
    tag: "Bearer · 4 endpoints",
    build: (name) =>
      `// ${name}
// API 混合场景 — 鉴权 + 列表 + 详情 + 创建。需设置 __ENV.BASE_URL 与 __ENV.TOKEN。

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
  group("浏览", function () {
    const list = http.get(\`\${BASE_URL}/items\`, authHeaders());
    check(list, { "列表 200": (r) => r.status === 200 });
    const items = list.json();
    if (items && items.length) {
      const detail = http.get(\`\${BASE_URL}/items/\${items[0].id}\`, authHeaders());
      check(detail, { "详情 200": (r) => r.status === 200 });
    }
    sleep(1);
  });
}

export function writeFlow() {
  group("写入", function () {
    const body = JSON.stringify({ name: "perf-pilot item" });
    const params = { headers: { "content-type": "application/json" } };
    const created = http.post(\`\${BASE_URL}/items\`, body, params);
    check(created, { "创建 2xx": (r) => r.status >= 200 && r.status < 300 });
  });
}
`,
  },

  // ------------------------------------------------------------ new in 0.2
  {
    id: "constant-arrival-rate",
    nameKey: "templates.constant-arrival-rate.name",
    descriptionKey: "templates.constant-arrival-rate.description",
    headerKey: "templates.constant-arrival-rate.header",
    tag: "100 RPS · 2m",
    build: (name) =>
      `// ${name}
// 恒定到达率 — 固定每秒请求数，与响应时间解耦，专门用于后端容量验证。
// 建议用于：SLA 验证、CI 性能门禁、容量规划基准。

import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    steady_load: {
      executor: "constant-arrival-rate",
      // 100 个请求 / 秒
      rate: 100,
      timeUnit: "1s",
      // 每秒最多排队的请求数（避免大量重试导致虚高）
      preAllocatedVUs: 50,
      maxVUs: 200,
      duration: "2m",
    },
  },
  thresholds: {
    // 后端容量测试 — 失败率硬阈值
    http_req_failed: ["rate<0.005"],
    http_req_duration: ["p(95)<300", "p(99)<800"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://api.example.com";

export default function () {
  const res = http.get(\`\${BASE_URL}/health\`);
  check(res, {
    "状态码 200": (r) => r.status === 200,
    "响应时间小于 200ms": (r) => r.timings.duration < 200,
  });
}
`,
  },
  {
    id: "breakpoint",
    nameKey: "templates.breakpoint.name",
    descriptionKey: "templates.breakpoint.description",
    headerKey: "templates.breakpoint.header",
    tag: "ramping-arrival-rate",
    build: (name) =>
      `// ${name}
// 拐点测试 — 渐进加大到达率，定位错误率/延迟开始失控的阈值。
// 推荐运行时长 5–10 分钟；目标：找到系统能稳定支撑的最大 RPS。

import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    breakpoint: {
      executor: "ramping-arrival-rate",
      // 从 50 RPS 起步，每个阶段 +50 RPS，持续 30 秒
      startRate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 500,
      stages: [
        { duration: "30s", target: 50 },
        { duration: "30s", target: 100 },
        { duration: "30s", target: 200 },
        { duration: "30s", target: 300 },
        { duration: "30s", target: 400 },
        { duration: "30s", target: 500 },
        { duration: "30s", target: 600 },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    // 故意把阈值放宽，让脚本能跑到极限；人工观察错误率拐点
    http_req_failed: ["rate<0.50"],
    http_req_duration: ["p(99)<5000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://api.example.com";

export default function () {
  const res = http.get(\`\${BASE_URL}/items\`);
  check(res, { "状态码 2xx": (r) => r.status >= 200 && r.status < 300 });
  sleep(0.1);
}
`,
  },
  {
    id: "grpc",
    nameKey: "templates.grpc.name",
    descriptionKey: "templates.grpc.description",
    headerKey: "templates.grpc.header",
    tag: "k6/net/grpc · 50 RPS",
    build: (name) =>
      `// ${name}
// gRPC 单次调用测试 — 需要将 .proto 编译进 k6 binary (xk6 扩展或
// GRPC_MODULE_REFLECTION 等环境变量)。此处展示常见 health check 调用。

import grpc from "k6/net/grpc";
import { check } from "k6";

const client = new grpc.Client();
client.load(["definitions"], "health.proto");

export const options = {
  scenarios: {
    grpc_health: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: 100,
      duration: "1m",
    },
  },
  thresholds: {
    grpc_req_duration: ["p(95)<100", "p(99)<300"],
  },
};

const GRPC_ADDR = __ENV.GRPC_ADDR || "localhost:50051";

export default function () {
  client.connect(GRPC_ADDR, { plaintext: true });
  const res = client.invoke("grpc.health.v1.Health/Check", {});
  check(res, {
    "状态 SERVING": (r) => r.status === grpc.StatusOK && r.message && r.message.status === 1,
  });
  client.close();
  // 不需要 sleep —— arrival-rate executor 已经按固定 RPS 派发
}
`,
  },
  {
    id: "websocket",
    nameKey: "templates.websocket.name",
    descriptionKey: "templates.websocket.description",
    headerKey: "templates.websocket.header",
    tag: "WS · 100 conns · 5m",
    build: (name) =>
      `// ${name}
// WebSocket 长连接测试 — 维持 N 条 WS 连接，周期性收发 ping/pong
// 检测服务端推送、断线重连和长连接资源占用。

import ws from "k6/ws";
import { check } from "k6";

export const options = {
  vus: 100,
  duration: "5m",
  thresholds: {
    ws_session_duration: ["p(95)<60000"],
    ws_connecting: ["p(95)<500"],
  },
};

const WS_URL = __ENV.WS_URL || "wss://echo.websocket.org";

export default function () {
  const url = \`\${WS_URL}?vu=\${__VU}\`;
  const res = ws.connect(url, null, function (socket) {
    socket.on("open", () => {
      socket.send("ping-from-vu-" + __VU);
    });
    socket.on("message", (data) => {
      check(data, { "收到消息": (d) => d && d.length > 0 });
    });
    socket.on("close", () => {});
    socket.on("error", (e) => {
      console.error("WS 错误:", e.error());
    });
    // 每 5 秒发送一次心跳；超时则关闭
    socket.setInterval(() => {
      socket.send("heartbeat-" + __VU);
    }, 5000);
    socket.setTimeout(() => socket.close(), 60_000);
  });
  check(res, { "握手成功": (r) => r && r.status === 101 });
}
`,
  },
  {
    id: "data-driven",
    nameKey: "templates.data-driven.name",
    descriptionKey: "templates.data-driven.description",
    headerKey: "templates.data-driven.header",
    tag: "CSV · SharedArray",
    build: (name) =>
      `// ${name}
// 数据驱动测试 — 用 SharedArray 从 ./data/users.csv 加载用户数据，
// 每个 VU 顺序消费一份（k6 会自动切分）。
//
// data/users.csv 格式（首行为表头）：
//   id,name,token
//   1,alice,token-abc
//   2,bob,token-def
//
// CSV 必须放在脚本同目录的 ./data/ 子目录下（k6 解析相对路径）。

import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import papaparse from "./lib/papaparse.js";

const users = new SharedArray("users", function () {
  // k6 解析相对路径，会在脚本同目录查找
  return papaparse.parse(open("./data/users.csv"), { header: true }).data;
});

export const options = {
  vus: 10,
  duration: "1m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<400"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://api.example.com";

export default function () {
  const u = users[__VU - 1] || users[0];
  if (!u) return;

  const headers = { headers: { Authorization: \`Bearer \${u.token}\` } };
  const profile = http.get(\`\${BASE_URL}/users/\${u.id}\`, headers);
  check(profile, { "个人资料 200": (r) => r.status === 200 });

  const body = JSON.stringify({ name: u.name, updated_at: new Date().toISOString() });
  const params = { headers: { "content-type": "application/json" } };
  const updated = http.put(\`\${BASE_URL}/users/\${u.id}\`, body, Object.assign({}, headers, params));
  check(updated, { "更新 2xx": (r) => r.status >= 200 && r.status < 300 });

  sleep(1);
}
`,
  },
];

export function getTemplate(id: string): ScriptTemplate | undefined {
  return SCRIPT_TEMPLATES.find((t) => t.id === id);
}

/**
 * Helper used by tests: return the set of i18n keys every template needs
 * resolved, so the test can assert both locale files define them all.
 */
export function requiredTemplateKeys(): { names: string[]; descriptions: string[]; headers: string[] } {
  const names = SCRIPT_TEMPLATES.map((t) => t.nameKey);
  const descriptions = SCRIPT_TEMPLATES.map((t) => t.descriptionKey);
  const headers = SCRIPT_TEMPLATES.map((t) => t.headerKey);
  return { names, descriptions, headers };
}