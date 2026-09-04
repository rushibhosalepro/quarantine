/**
 * Minimal ambient types for the WebMCP browser API.
 * Written against Chrome's imperative-API documentation; the API ships behind
 * chrome://flags/#enable-webmcp-testing and is not in lib.dom yet.
 */

export interface ToolContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  /** Marks output as containing content this page does not vouch for. */
  untrustedContentHint?: boolean;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  exposedTo?: string[];
  execute: (input: any, ctx?: { signal?: AbortSignal }) => Promise<ToolResult>;
}

export interface ModelContext extends EventTarget {
  registerTool(tool: ToolDescriptor, options?: { signal?: AbortSignal }): Promise<void>;
  getTools?(options?: { fromOrigins?: string[] }): Promise<ToolDescriptor[]>;
  executeTool?(tool: string | ToolDescriptor, input: unknown, options?: unknown): Promise<ToolResult>;
  unregisterTool?(name: string): Promise<void>;
}

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface SubmitEvent {
    /** True when an agent triggered submission of a declarative tool form. */
    agentInvoked?: boolean;
    respondWith?(result: Promise<unknown>): void;
  }
}
