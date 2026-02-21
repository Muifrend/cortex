import { MCPServer } from "mcp-use/server";
import { registerCortexTools } from "./tools/index.js";

const server = new MCPServer({
  name: "cortex",
  title: "cortex",
  version: "1.0.0",
  description: "Personal knowledge graph MCP server for notes and connections",
  baseUrl: process.env.MCP_URL || "http://localhost:3000",
  favicon: "favicon.ico",
  websiteUrl: "https://mcp-use.com",
  icons: [
    {
      src: "icon.svg",
      mimeType: "image/svg+xml",
      sizes: ["512x512"],
    },
  ],
});

registerCortexTools(server);

server.listen().then(() => {
  console.log(`Server running`);
});
