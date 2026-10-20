// Run only against a disposable, idle gateway/Redis pair with a fresh principal.
// k6 run -e TARGET_URL=http://localhost:3000/api/v1/orders \
//   -e BEARER_TOKEN=... -e QUOTA=600 scripts/load-global-rate-limit.js
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const quota = Number(__ENV.QUOTA || 60);
if (![60, 600, 3000].includes(quota)) throw new Error("QUOTA must be 60, 600 or 3000");
const admitted = new Counter("admitted_requests");
const denied = new Counter("denied_requests");
// Ten seconds admits at most initial capacity plus ten seconds of refill.
const maxAdmitted = quota + Math.ceil(quota * 10 / 60);
export const options = {
  scenarios: {
    global_quota: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "10s",
      preAllocatedVUs: 1000,
      maxVUs: 1000,
      gracefulStop: "0s",
    },
  },
  thresholds: {
    checks: ["rate==1"],
    dropped_iterations: ["count==0"],
    admitted_requests: [`count>=${quota}`, `count<=${maxAdmitted}`],
    denied_requests: ["count>0"],
  },
};

export default function () {
  const response = http.get(__ENV.TARGET_URL || "http://localhost:3000/api/v1/orders", {
    headers: __ENV.BEARER_TOKEN ? { Authorization: `Bearer ${__ENV.BEARER_TOKEN}` } : {},
    redirects: 0,
  });
  const remaining = Number(response.headers["X-Ratelimit-Remaining"]);
  check(response, {
    "successful request or quota denial": (r) => r.status === 200 || r.status === 429,
    "correct quota header": (r) => Number(r.headers["X-Ratelimit-Limit"]) === quota,
    "remaining is bounded": () => Number.isInteger(remaining) && remaining >= 0 && remaining < quota,
    "denials include positive retry time": (r) => r.status !== 429 || Number(r.headers["Retry-After"]) >= 1,
  });
  if (response.status === 200) admitted.add(1);
  if (response.status === 429) denied.add(1);
}
