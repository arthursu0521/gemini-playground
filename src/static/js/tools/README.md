# Adding tools

The model can call tools during a Live session. `tool-manager.js` registers them and sends their declarations in the
session setup. There are two kinds:

- **Built-in tools** run at Google (for example Google Search grounding). They only need a declaration.
- **Function tools** run in the browser. The model sends a `toolCall`, the `ToolManager` runs your `execute()` and the
  client sends the result back as a `toolResponse`. Several calls in one message run in parallel; calls the server
  cancels are aborted through the `signal` you receive.

## A function tool

```js
// js/tools/time-tool.js
export class TimeTool {
    getDeclaration() {
        return [{
            name: 'get_current_time',
            description: 'Returns the current time in a time zone',
            parameters: {
                type: 'object',
                properties: { timeZone: { type: 'string', description: 'IANA time zone, e.g. Asia/Shanghai' } },
                required: ['timeZone'],
            },
        }];
    }

    async execute(args, { signal }) {
        // Use `signal` with fetch() so cancelled calls stop early: fetch(url, { signal })
        return new Date().toLocaleString('en-US', { timeZone: String(args.timeZone) });
    }
}
```

Whatever `execute()` returns is sent as `{ output: ... }`; a thrown error is sent as `{ error: message }`.

## A built-in tool

```js
export class CodeExecutionTool {
    builtin = true;
    getDeclaration() {
        return { codeExecution: {} };
    }
}
```

## Register it

In `tool-manager.js`, add it next to the defaults:

```js
this.registerTool('time', new TimeTool());
```

Tool and function names must be unique; registering a duplicate throws.

## Notes

- Tools run in the visitor's browser: never put secrets in them. Calls to third-party APIs also need their origin added
  to `connect-src` in the Content-Security-Policy (`src/server/security.ts` and `src/static/_headers`).
- `weather-tool.js` is a demo: it returns generated data and says so in its result.
- Add a unit test next to the existing ones in `tests/frontend/tools_settings_test.ts`.
