const fs = require("node:fs");
const path = require("node:path");
const name = process.argv[2];
const root = __dirname;
fs.writeFileSync(path.join(root, `${name}.pid`), String(process.pid));
fs.writeSync(1, `${name}_FIRST\r\n` + "start line\r\n".repeat(200));
fs.writeSync(2, `${name}_STDERR_中文`);
let phase = 1;
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(root, `${name}.${phase}.release`))) return;
  if (phase === 1)
    fs.writeSync(1, "x".repeat(9000) + `\r\n${name}_SECOND_中文\r\n` + "tail line\r\n".repeat(160));
  if (phase === 2) fs.writeSync(2, `${name}_THIRD_no_newline`);
  if (phase === 3) {
    fs.writeSync(1, `${name}_FINAL`);
    clearInterval(timer);
  }
  phase++;
}, 30);
