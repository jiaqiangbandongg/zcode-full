# Image Search for ZCode

[中文文档](./README_CN.md)

This plugin registers the official ZCode image search MCP server, so the agent can look up
illustrations and reference images while producing documents, slides, posters, or web pages.

## Components

- MCP server `image_search` (HTTP), namespaced as `plugin:image-search:image_search`.

## Requirements

- A ZCode session signed in to an account that can reach `${ZCODE_BASE_URL}`; the server uses
  official ZCode JWT authentication, so no manual token or API key is needed.
- Network access to the ZCode API endpoint.
- Start a new ZCode session after installing or updating the plugin.

## Usage

Once installed, ask for images in natural language — for example "find a photo of a wind farm for
the cover" — and the agent calls the image search tool. It pairs well with the `documents`, `pdf`,
and `presentations` plugins, which no longer bundle this MCP server: install this plugin alongside
them when you want image search available during document production.

## Notes

- The plugin only declares an MCP server; it ships no commands, skills, hooks, or agents.
- Search results come from a third-party image index through the ZCode service. Check the license of
  any image before using it in a published deliverable.
