// Drive the same test file repeatedly, concurrently, in one process each.
import { spawn } from "node:child_process";
const N = Number(process.argv[2] ?? 4);
const runs = Number(process.argv[3] ?? 3);
let hits = 0;
for (let r = 0; r < runs; r++) {
  const kids = [];
  for (let i = 0; i < N; i++) {
    kids.push(new Promise((res) => {
      const c = spawn(process.execPath, ["--import","tsx","--test","--test-concurrency","4","tests/plugin-fork.test.ts"], { stdio: ["ignore","pipe","pipe"] });
      let out = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => out += d);
      c.on("exit", () => res(out));
    }));
  }
  const outs = await Promise.all(kids);
  for (const o of outs) {
    const bad = /^not ok /m.test(o);
    if (bad) { hits++; const m = o.match(/PROBE[\s\S]{0,120}/); console.log("HIT:", m ? m[0].replace(/\n/g," | ") : "(no probe line)"); }
  }
  console.log(`round ${r+1}/${runs} hits=${hits}`);
}
