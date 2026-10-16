/** 只生成已声明的组件；模板中的路径由插件 loader 在运行时解析。 */
export function scaffoldFiles(name, components) {
  const manifest = {
    name,
    version: "0.1.0",
    description: `${name} plugin`,
    author: { name: "Local developer" },
  };
  const files = new Map();
  files.set(
    "README.md",
    `# ${name}\n\nDescribe this plugin's workflow and required configuration here.\n\nValidate before installation: \`zcode plugins validate .\`.\n`,
  );
  if (components.includes("skills")) {
    manifest.skills = "./skills";
    files.set(
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Guide the ${name} workflow when the user explicitly requests this plugin.\n---\n\n# ${name}\n\nClarify the requested outcome, inspect the available inputs, and agree on the concrete implementation before executing the workflow.\n`,
    );
  }
  if (components.includes("commands")) {
    manifest.commands = "./commands";
    files.set(
      "commands/help.md",
      `---\ndescription: Explain the ${name} plugin workflow\n---\n\nRead this plugin's README and explain its available capabilities.\n`,
    );
  }
  if (components.includes("hooks")) {
    manifest.hooks = "./hooks/hooks.json";
    files.set(
      "hooks/hooks.json",
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.mjs"',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    files.set(
      "scripts/session-start.mjs",
      "// 启动钩子默认无副作用；实现明确的插件行为后再输出上下文。\n",
    );
  }
  if (components.includes("mcp")) {
    manifest.mcpServers = "./.mcp.json";
    files.set(
      ".mcp.json",
      JSON.stringify(
        {
          mcpServers: {
            [name]: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs"] },
          },
        },
        null,
        2,
      ) + "\n",
    );
    files.set(
      "scripts/mcp-server.mjs",
      `import { createInterface } from "node:readline";\n// 最小 MCP 握手骨架；只在实现真实工具后扩展 tools/list 和 tools/call。\nfor await (const line of createInterface({ input: process.stdin })) {\n  const message = JSON.parse(line);\n  if (message.id === undefined) continue;\n  const result = message.method === "initialize"\n    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: ${JSON.stringify(name)}, version: "0.1.0" } }\n    : message.method === "tools/list" ? { tools: [] } : message.method === "ping" ? {} : undefined;\n  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result ? { result } : { error: { code: -32601, message: "Method not found" } }) }) + "\\n");\n}\n`,
    );
  }
  for (const directory of ["scripts", "assets"])
    if (components.includes(directory)) files.set(`${directory}/.gitkeep`, "");
  files.set(".zcode-plugin/plugin.json", JSON.stringify(manifest, null, 2) + "\n");
  return files;
}
