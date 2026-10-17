/**
 * OpenAI-compatible API. Requests are forwarded to Google's official OpenAI compatibility layer
 * (`/v1beta/openai/...`), which supports chat completions (incl. streaming, tools, structured
 * output, images, audio), embeddings, models and image generation. The relay only authenticates,
 * fills in default models and streams the response back unchanged.
 */
import type { AppConfig } from './config.ts';
import { resolveCredentials, tokenFromHeaders } from './credentials.ts';
import type { Logger } from './log.ts';
import { corsHeaders, preflightHeaders } from './security.ts';

const PATH_PATTERN =
    /^(?:\/v1|\/v1beta\/openai|\/openai(?:\/v1)?)?\/(chat\/completions|embeddings|images\/generations|models(?:\/[A-Za-z0-9._\-]+)?)$/;

/** Returns the upstream sub-path (e.g. `chat/completions`) or null if the path is not an API route. */
export function matchOpenAIPath(pathname: string): string | null {
    return PATH_PATTERN.exec(pathname)?.[1] ?? null;
}

export interface OpenAIDeps {
    config: AppConfig;
    logger: Logger;
    fetch: typeof fetch;
}

function errorResponse(status: number, message: string, type: string, headers: Headers): Response {
    headers.set('content-type', 'application/json');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify({ error: { message, type, code: status } }), { status, headers });
}

async function readBody(req: Request, limit: number): Promise<string | null> {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > limit) return null;
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(all);
}

export async function handleOpenAI(req: Request, subpath: string, deps: OpenAIDeps): Promise<Response> {
    const { config, logger } = deps;
    const origin = req.headers.get('origin');

    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: preflightHeaders(origin, config) });
    }

    const isModels = subpath === 'models' || subpath.startsWith('models/');
    const expectedMethod = isModels ? 'GET' : 'POST';
    if (req.method !== expectedMethod) {
        const headers = corsHeaders(origin, config);
        headers.set('allow', expectedMethod);
        return errorResponse(405, `Use ${expectedMethod} for /${subpath}`, 'invalid_request_error', headers);
    }

    const credential = await resolveCredentials({ apiKey: tokenFromHeaders(req.headers) }, config);
    if (!credential.ok) {
        return errorResponse(
            401,
            `${credential.reason}. Send "Authorization: Bearer <Gemini API key>"`,
            'authentication_error',
            corsHeaders(origin, config),
        );
    }

    let body: string | undefined;
    if (expectedMethod === 'POST') {
        const raw = await readBody(req, config.maxRequestBodyBytes);
        if (raw === null) {
            return errorResponse(413, 'Request body too large', 'invalid_request_error', corsHeaders(origin, config));
        }
        let json: Record<string, unknown>;
        try {
            json = JSON.parse(raw);
            if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
        } catch {
            return errorResponse(
                400,
                'Body must be a JSON object',
                'invalid_request_error',
                corsHeaders(origin, config),
            );
        }
        if (typeof json.model !== 'string' || !json.model.trim()) {
            if (subpath === 'chat/completions') json.model = config.defaultChatModel;
            else if (subpath === 'embeddings') json.model = config.defaultEmbeddingModel;
        }
        body = JSON.stringify(json);
    }

    const target = `${config.upstreamBaseUrl}/v1beta/openai/${subpath}`;
    const upstreamHeaders = new Headers({ authorization: `Bearer ${credential.apiKey}` });
    if (body !== undefined) upstreamHeaders.set('content-type', 'application/json');
    const accept = req.headers.get('accept');
    if (accept) upstreamHeaders.set('accept', accept);

    let upstream: Response;
    try {
        upstream = await deps.fetch(target, {
            method: expectedMethod,
            headers: upstreamHeaders,
            body,
        });
    } catch (error) {
        logger.error('openai upstream request failed', { path: subpath, error });
        return errorResponse(502, 'Could not reach the Gemini API', 'api_error', corsHeaders(origin, config));
    }

    logger.info('openai request', { path: subpath, status: upstream.status, keySource: credential.source });
    const headers = corsHeaders(origin, config);
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json');
    headers.set('cache-control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
}
