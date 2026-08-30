import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';

const pageOrigin = 'http://127.0.0.1:4173';
const pageUrl = `${pageOrigin}/Skill-Tree-Maker/`;
const relayPackage = '@mcp-b/webmcp-local-relay@5.0.1';
const expectedTool = 'skill_tree_get_context';
const timeoutMs = 30_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTools(client) {
  const startedAt = Date.now();
  let lastNames = [];
  while (Date.now() - startedAt < timeoutMs) {
    const list = await client.listTools();
    lastNames = list.tools.map((tool) => tool.name).sort();
    if (lastNames.includes(expectedTool)) return list.tools;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${expectedTool}. Visible MCP tools: ${lastNames.join(', ') || '(none)'}`);
}

const transport = new StdioClientTransport({
  command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
  args: [
    '-y',
    relayPackage,
    '--widget-origin',
    pageOrigin,
    '--invoke-timeout',
    '125000',
  ],
});
const client = new Client(
  { name: 'skill-tree-maker-e2e', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);

let browser;
try {
  await client.connect(transport);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await page.locator('.webmcp-button').click();
  const enableButton = page.locator('[data-mcp-action="enable"]');
  if ((await enableButton.textContent())?.includes('Enable MCP')) {
    await enableButton.click();
  }

  await page.waitForFunction(
    () => document.querySelector('.webmcp-panel')?.textContent?.includes('Skill Tree Maker tools published'),
    undefined,
    { timeout: timeoutMs },
  );

  const tools = await waitForTools(client);
  const dynamicTools = tools.filter((tool) => tool.name.startsWith('skill_tree_'));
  if (dynamicTools.length < 10) {
    throw new Error(`Expected the Skill Tree Maker tool suite, found only ${dynamicTools.length}: ${dynamicTools.map((tool) => tool.name).join(', ')}`);
  }

  const contextTool = tools.find((tool) => tool.name === expectedTool);
  if (!contextTool?.inputSchema || contextTool.inputSchema.type !== 'object') {
    throw new Error(`${expectedTool} does not expose an object input schema.`);
  }

  const result = await client.callTool({ name: expectedTool, arguments: {} });
  if (result.isError) {
    throw new Error(`${expectedTool} invocation returned an MCP error: ${JSON.stringify(result)}`);
  }
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item.type === 'text')?.text
    : undefined;
  if (typeof text !== 'string' || !text.includes('protocolVersion')) {
    throw new Error(`${expectedTool} did not return the expected context payload: ${JSON.stringify(result)}`);
  }

  if (pageErrors.length) {
    throw new Error(`Browser page errors during MCP E2E: ${pageErrors.join(' | ')}`);
  }

  console.log(`MCP E2E passed with ${dynamicTools.length} Skill Tree Maker tools. ${expectedTool} invoked successfully.`);
} finally {
  await browser?.close();
  await client.close().catch(() => undefined);
}
