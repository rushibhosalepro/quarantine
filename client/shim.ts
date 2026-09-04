/**
 * A minimal, clearly-labelled stand-in for `document.modelContext`.
 *
 * WHY THIS EXISTS
 * The WebMCP API ships behind chrome://flags/#enable-webmcp-testing. Without the
 * flag, `document.modelContext` is undefined and nothing registers, so the page
 * cannot demonstrate anything to a visitor who will not restart their browser.
 *
 * WHAT IT IS NOT
 * This is not an implementation of WebMCP and it does not emulate the browser's
 * behaviour. It is a registry: it stores the exact same tool descriptors this app
 * passes to the real `registerTool`, and invokes the exact same `execute`
 * functions. Everything downstream of registration -- the policy checks, the
 * approval gate, the ledger -- runs identically.
 *
 * The page always says which one is in use. See the badge in the header.
 */

import type { ModelContext, ToolDescriptor, ToolResult } from '../types/webmcp.d.ts';

export let usingShim = false;

class ShimModelContext extends EventTarget implements ModelContext {
  private tools = new Map<string, ToolDescriptor>();

  async registerTool(tool: ToolDescriptor, options?: { signal?: AbortSignal }): Promise<void> {
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener('abort', () => {
      // Mirrors Chrome 153+ signal-based unregistration.
      if (this.tools.get(tool.name) === tool) {
        this.tools.delete(tool.name);
        this.dispatchEvent(new Event('toolchange'));
      }
    });
    this.dispatchEvent(new Event('toolchange'));
  }

  async getTools(): Promise<ToolDescriptor[]> {
    return [...this.tools.values()];
  }

  async executeTool(tool: string | ToolDescriptor, input: unknown): Promise<ToolResult> {
    const name = typeof tool === 'string' ? tool : tool.name;
    const t = this.tools.get(name);
    if (!t) {
      // The important case: a tool policy has withdrawn is simply not here.
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'NO_SUCH_TOOL',
                name,
                reason:
                  'This tool is not registered. It is absent from the tool surface, not disabled — ' +
                  'there is nothing to call. Use explain_policy to find out why.',
                registered: [...this.tools.keys()],
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    return await t.execute(input, {});
  }

  async unregisterTool(name: string): Promise<void> {
    this.tools.delete(name);
    this.dispatchEvent(new Event('toolchange'));
  }
}

/**
 * Install the shim only when the real API is absent. If Chrome provides
 * `document.modelContext`, this does nothing and the real API is used.
 */
export function installShimIfNeeded(): boolean {
  if (document.modelContext) return false;
  Object.defineProperty(document, 'modelContext', {
    value: new ShimModelContext(),
    configurable: true,
    writable: true,
  });
  usingShim = true;
  console.info(
    '[quarantine] document.modelContext was absent — installed the local registry shim. ' +
      'Enable chrome://flags/#enable-webmcp-testing for the real browser API.',
  );
  return true;
}
