---
name: ios-dev
description: Build, run, inspect, and lightly automate iOS simulator apps with the ios-simulator MCP tools.
---

# iOS Dev

Use this skill when the user wants you to create, modify, build, run, debug, screenshot, or inspect an iOS app in the macOS iOS Simulator.

## ZCode Tool Names

This skill assumes the MCP server is configured in zcode as `ios_simulator`. In zcode, MCP tools are exposed to the model as `mcp__ios_simulator__<tool>`.

If the server is configured with a different name, use the corresponding visible `mcp__<server>__...` tool names from the active zcode tool list.

## Default Workflow

1. Call `mcp__ios_simulator__ios_preflight` first.
   - If full Xcode or `simctl` is missing, stop the simulator workflow and explain the exact missing check.
   - Command Line Tools alone are not enough for this plugin.
2. Discover the project with `mcp__ios_simulator__ios_discover_project`.
   - If no Xcode project exists and the user wants a new app, call `mcp__ios_simulator__ios_create_app`.
   - Prefer editing the generated SwiftUI files directly after project creation.
   - `mcp__ios_simulator__ios_create_app` refuses to overwrite generated files by default; only pass `overwrite: true` after explicit user confirmation.
3. Build and launch with `mcp__ios_simulator__ios_build_and_run`.
   - Pass `scheme` when multiple schemes exist.
   - Use `openSimulator: true` when the user expects to see the macOS Simulator window.
   - Read the returned `output` first for compile errors; use the returned log path only when more detail is needed.
4. Verify the app visually with `mcp__ios_simulator__ios_screenshot`.
5. For simple runtime checks, use `mcp__ios_simulator__ios_open_url`, `mcp__ios_simulator__ios_launch_app`, `mcp__ios_simulator__ios_terminate_app`, and `mcp__ios_simulator__ios_logs`.
6. For UI automation, call `mcp__ios_simulator__ios_ui_status` first.
   - `mcp__ios_simulator__ios_ui_tap`, `mcp__ios_simulator__ios_ui_swipe`, `mcp__ios_simulator__ios_ui_type_text`, `mcp__ios_simulator__ios_ui_button`, and `mcp__ios_simulator__ios_ui_describe` require the optional `idb` backend.
   - If `idb` is unavailable, continue with build/run/screenshot checks and say UI automation is unavailable.

## Tool Notes

- This MVP intentionally uses Apple's macOS Simulator app for rendering. Do not create or expect a custom simulator window.
- The MCP tools accept `udid`, `device`, and `runtime` when a specific simulator is needed. Otherwise they choose the booted simulator, then the configured default iPhone device.
- Keep simulator interactions through MCP tools instead of raw `xcrun` commands unless a tool does not cover the operation.
- `mcp__ios_simulator__ios_create_app` generates a minimal SwiftUI app suitable for model-driven iteration.
- `mcp__ios_simulator__ios_build_app` only builds. `mcp__ios_simulator__ios_build_and_run` builds, installs, launches, and opens Simulator.

## Extension Point

The UI backend is deliberately isolated. P0 uses `idb` when installed; future backends can map the same public operations to XcodeBuildMCP, native Accessibility, or another automation bridge without changing the skill workflow.
