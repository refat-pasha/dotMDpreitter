const { spawnSync } = require("child_process");
const suites = [
  ["unit (markdown/notes/store/exporters)", "selftest.js"],
  ["api (auth + storage + isolation)", "apitest.js"],
  ["cloud client contract", "cloudtest.js"],
];
let bad = 0;
for (const [name, file] of suites) {
  const r = spawnSync(process.execPath, [file], { encoding: "utf8" });
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || "");
  const p = m ? m[1] : "?";
  const f = m ? m[2] : "?";
  if (f !== "0") bad++;
  console.log(String(f === "0" ? "OK  " : "FAIL") + "  " + String(p).padStart(3) + " passed  " + name);
}
console.log("\n" + (bad ? bad + " suite(s) failing" : "All suites green"));
process.exit(bad ? 1 : 0);
