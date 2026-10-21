import fs from "node:fs";
import p from "node:path";

["routes", "src", "middleware"].forEach((d) => {
  const s = p.join("dist", "gateway", d);
  const t = p.join("dist", d);
  if (fs.existsSync(s) && !fs.existsSync(t)) {
    try {
      fs.symlinkSync(p.join("gateway", d), t, "dir");
    } catch {
      fs.cpSync(s, t, { recursive: true });
    }
  }
});
