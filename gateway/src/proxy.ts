/**
 * Reverse proxy for the streamable-HTTP MCP transport.
 *
 * Forwards /mcp requests (POST JSON-RPC, GET SSE stream, DELETE session)
 * to the upstream Graphiti MCP server, streaming the response back and
 * relaying Mcp-Session-Id in both directions.
 */

const REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

const RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "cache-control",
] as const;

/**
 * Forward one MCP request to the given tenant's upstream. Stateless: no
 * session cache is kept in the gateway, so an Mcp-Session-Id can only ever
 * reach the single upstream resolved for the authenticated user.
 */
export async function proxyMcp(upstreamUrl: string, req: Request): Promise<Response> {
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? await req.arrayBuffer() : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: req.signal,
      });
    } catch (err) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message: `Upstream MCP server unreachable at ${upstreamUrl}`,
          },
        },
        { status: 502 },
      );
    }

    const responseHeaders = new Headers();
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }

    // Stream the body straight through (supports both JSON and SSE).
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
}
