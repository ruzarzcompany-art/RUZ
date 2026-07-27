import type { Config, Context } from "@netlify/functions";
import serverless from "serverless-http";
import { createApp } from "../../server/app.js";

type ServerlessHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<{
  statusCode: number;
  body: string;
  isBase64Encoded: boolean;
  headers: Record<string, string>;
  cookies?: string[];
}>;

let handler: ServerlessHandler | undefined;

function getHandler(): ServerlessHandler {
  if (!handler) {
    handler = serverless(createApp(), {
      binary: false,
      provider: "aws",
    }) as unknown as ServerlessHandler;
  }
  return handler;
}

/**
 * يشغّل تطبيق Express داخل دالة Netlify.
 * يحوّل طلب Web API القياسي إلى صيغة الحدث التي يفهمها `serverless-http`
 * (HTTP API v2) ثم يعيد الاستجابة كـ Response قياسي.
 */
export default async (req: Request, context: Context): Promise<Response> => {
  const url = new URL(req.url);

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const bodyBuffer = hasBody ? Buffer.from(await req.arrayBuffer()) : Buffer.alloc(0);

  const event = {
    version: "2.0",
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ""),
    headers,
    body: bodyBuffer.toString("base64"),
    isBase64Encoded: true,
    requestContext: {
      requestId: context.requestId,
      http: {
        method: req.method,
        path: url.pathname,
        sourceIp: context.ip ?? "",
        userAgent: headers["user-agent"] ?? "",
      },
    },
  };

  const result = await getHandler()(event, {});

  const responseHeaders = new Headers(result.headers ?? {});
  for (const cookie of result.cookies ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }

  const body = result.isBase64Encoded
    ? Buffer.from(result.body, "base64")
    : result.body;

  return new Response(result.statusCode === 204 ? null : body, {
    status: result.statusCode,
    headers: responseHeaders,
  });
};

export const config: Config = {
  path: "/api/*",
};
