// @ts-check
/**
 * @fileoverview Grounding with Google Search. Google runs the search server-side, so this tool is
 * only a declaration: nothing executes in the browser.
 */
export class GoogleSearchTool {
    /** @type {true} */
    builtin = true;

    getDeclaration() {
        return { googleSearch: {} };
    }
}
