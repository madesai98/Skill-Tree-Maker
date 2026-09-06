import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium } from 'playwright';

const pageOrigin = 'http://127.0.0.1:4173';
const pageUrl = `${pageOrigin}/Skill-Tree-Maker/`;
const relayPackage = '@mcp-b/webmcp-local-relay@5.0.1';
const expectedTool = 'skill_tree_list_stat_groups';
const timeoutMs = 30_000;
const toolSettleMs = 3_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listSkillTreeToolNames(client) {
  const list = await client.listTools();
  return list.tools
    .filter((tool) => tool.name.startsWith('skill_tree_'))
    .map((tool) => tool.name)
    .sort();
}

async function waitForStableSkillTreeTools(client) {
  const startedAt = Date.now();
  let lastNames = [];
  let stableSince = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const names = await listSkillTreeToolNames(client);
    const same = JSON.stringify(names) === JSON.stringify(lastNames);
    if (!same) {
      lastNames = names;
      stableSince = Date.now();
    } else if (names.length >= 10 && names.includes(expectedTool) && Date.now() - stableSince >= toolSettleMs) {
      return names;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for the Skill Tree Maker tool suite to stabilize. Visible MCP tools: ${lastNames.join(', ') || '(none)'}`);
}

async function waitForTool(client, toolName) {
  const startedAt = Date.now();
  let names = [];
  while (Date.now() - startedAt < timeoutMs) {
    names = await listSkillTreeToolNames(client);
    if (names.includes(toolName)) return names;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${toolName}. Visible Skill Tree Maker tools: ${names.join(', ') || '(none)'}`);
}

async function callJsonTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} returned an MCP error: ${JSON.stringify(result)}`);
  const text = Array.isArray(result.content)
    ? result.content.find((item) => item.type === 'text')?.text
    : undefined;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${name} did not return a text payload: ${JSON.stringify(result)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} did not return JSON text: ${text}`);
  }
}

async function assertOneSource(client, label) {
  const payload = await callJsonTool(client, 'webmcp_list_sources');
  const sources = Array.isArray(payload?.sources) ? payload.sources : Array.isArray(payload) ? payload : null;
  const count = typeof payload?.count === 'number' ? payload.count : sources?.length;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one connected WebMCP source, got ${String(count)}: ${JSON.stringify(payload)}`);
  }
}

async function enableMcp(page) {
  await page.goto(pageUrl, { waitUntil: 'networkidle' });
  await page.locator('.webmcp-button').click();
  const enableButton = page.locator('[data-mcp-action="enable"]');
  if ((await enableButton.textContent())?.includes('Enable MCP')) {
    await enableButton.click();
  }
  await page.locator('[data-mcp-action="close"]').click();
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
let browserContext;
try {
  await client.connect(transport);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`tab 1: ${error.message}`));

  await enableMcp(page);

  await page.waitForFunction(
    () => document.querySelector('.webmcp-button-status')?.textContent?.includes('tools'),
    undefined,
    { timeout: timeoutMs },
  );

  const initialTools = await waitForStableSkillTreeTools(client);
  await assertOneSource(client, 'single-tab baseline');

  const secondPage = await browserContext.newPage();
  secondPage.on('pageerror', (error) => pageErrors.push(`tab 2: ${error.message}`));
  await enableMcp(secondPage);
  await secondPage.bringToFront();

  await secondPage.waitForFunction(
    () => document.querySelector('.webmcp-button-status')?.textContent?.includes('tools'),
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => document.querySelector('.webmcp-button-status')?.textContent === 'Standby',
    undefined,
    { timeout: timeoutMs },
  );
  const secondTabTools = await waitForTool(client, expectedTool);
  await assertOneSource(client, 'second-tab handoff');

  await page.bringToFront();
  await page.locator('.webmcp-button').click();
  await page.locator('[data-mcp-action="close"]').click();
  await page.waitForFunction(
    () => document.querySelector('.webmcp-button-status')?.textContent?.includes('tools'),
    undefined,
    { timeout: timeoutMs },
  );
  await secondPage.waitForFunction(
    () => document.querySelector('.webmcp-button-status')?.textContent === 'Standby',
    undefined,
    { timeout: timeoutMs },
  );
  const returnedTools = await waitForTool(client, expectedTool);
  await assertOneSource(client, 'first-tab handoff return');

  const contextTool = (await client.listTools()).tools.find((tool) => tool.name === expectedTool);
  if (!contextTool?.inputSchema || contextTool.inputSchema.type !== 'object') {
    throw new Error(`${expectedTool} does not expose an object input schema.`);
  }

  await callJsonTool(client, expectedTool);

  if (pageErrors.length) {
    throw new Error(`Browser page errors during MCP E2E: ${pageErrors.join(' | ')}`);
  }

  console.log(`MCP E2E passed: initial=${initialTools.length} tools, second-tab=${secondTabTools.length}, returned=${returnedTools.length}, exactly one connected source throughout both handoffs, and successful ${expectedTool} invocation.`);
} finally {
  await browserContext?.close().catch(() => undefined);
  await browser?.close();
  await client.close().catch(() => undefined);
}
