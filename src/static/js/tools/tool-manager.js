// @ts-check
/**
 * @fileoverview Registry for tools the model can use.
 *
 * Two kinds of tools:
 * - built-in tools executed by Google (e.g. Google Search): only a declaration, no code here;
 * - function tools executed in the browser: `getDeclaration()` returns function declarations and
 *   `execute(args, { signal })` returns the result.
 */
import { ApplicationError, ErrorCodes } from '../utils/error-boundary.js';
import { Logger } from '../utils/logger.js';
import { GoogleSearchTool } from './google-search.js';
import { WeatherTool } from './weather-tool.js';

/**
 * @typedef {{ name: string, description?: string, parameters?: object }} FunctionDeclaration
 * @typedef {{ builtin: true, getDeclaration(): Record<string, object> }} BuiltinTool
 * @typedef {{ builtin?: false, getDeclaration(): FunctionDeclaration[],
 *             execute(args: Record<string, unknown>, ctx: { signal: AbortSignal }): Promise<unknown> }} FunctionTool
 * @typedef {{ id?: string, name: string, args?: Record<string, unknown> }} FunctionCall
 * @typedef {{ id?: string, name: string, response: Record<string, unknown> }} FunctionResponse
 */

export class ToolManager {
    /** @param {{ registerDefaults?: boolean }} [options] */
    constructor(options = {}) {
        /** @type {Map<string, BuiltinTool | FunctionTool>} */
        this.tools = new Map();
        /** @type {Map<string, FunctionTool>} function name -> tool */
        this.functions = new Map();
        /** @type {Map<string, AbortController>} call id -> controller */
        this.pending = new Map();
        if (options.registerDefaults !== false) {
            this.registerTool('googleSearch', new GoogleSearchTool());
            this.registerTool('weather', new WeatherTool());
        }
    }

    /**
     * @param {string} name
     * @param {BuiltinTool | FunctionTool} tool
     */
    registerTool(name, tool) {
        if (this.tools.has(name)) {
            throw new ApplicationError(`Tool ${name} is already registered`, ErrorCodes.INVALID_STATE);
        }
        if (!tool.builtin) {
            for (const declaration of /** @type {FunctionTool} */ (tool).getDeclaration()) {
                if (this.functions.has(declaration.name)) {
                    throw new ApplicationError(
                        `Function ${declaration.name} is already registered`,
                        ErrorCodes.INVALID_STATE,
                    );
                }
                this.functions.set(declaration.name, /** @type {FunctionTool} */ (tool));
            }
        }
        this.tools.set(name, tool);
    }

    /** @returns {object[]} the `tools` array for the Live API setup message */
    getToolDeclarations() {
        /** @type {object[]} */
        const declarations = [];
        /** @type {FunctionDeclaration[]} */
        const functionDeclarations = [];
        for (const tool of this.tools.values()) {
            if (tool.builtin) declarations.push(tool.getDeclaration());
            else functionDeclarations.push(.../** @type {FunctionTool} */ (tool).getDeclaration());
        }
        if (functionDeclarations.length) declarations.push({ functionDeclarations });
        return declarations;
    }

    /**
     * Executes all calls of one `toolCall` message in parallel.
     * Calls cancelled meanwhile (see {@link cancel}) are left out of the result.
     * @param {FunctionCall[]} calls
     * @returns {Promise<FunctionResponse[]>}
     */
    async executeAll(calls) {
        const results = await Promise.all(calls.map((call) => this.#execute(call)));
        return /** @type {FunctionResponse[]} */ (results.filter(Boolean));
    }

    /**
     * @param {FunctionCall} call
     * @returns {Promise<FunctionResponse | null>}
     */
    async #execute(call) {
        const { id, name, args = {} } = call;
        const controller = new AbortController();
        if (id) this.pending.set(id, controller);
        try {
            const tool = this.functions.get(name);
            if (!tool) throw new ApplicationError(`Unknown tool: ${name}`, ErrorCodes.TOOL_NOT_FOUND);
            Logger.info(`Tool call: ${name}`, args);
            const output = await tool.execute(args, { signal: controller.signal });
            if (controller.signal.aborted) return null;
            return { id, name, response: { output } };
        } catch (error) {
            if (controller.signal.aborted) return null;
            Logger.error(`Tool ${name} failed`, error);
            return { id, name, response: { error: error instanceof Error ? error.message : String(error) } };
        } finally {
            if (id) this.pending.delete(id);
        }
    }

    /** @param {string[]} ids */
    cancel(ids) {
        for (const id of ids) {
            this.pending.get(id)?.abort();
            this.pending.delete(id);
        }
    }
}
