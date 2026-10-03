import { env, WorkerEntrypoint } from "cloudflare:workers";

/**
 * Env-Test Service
 * Simple Cloudflare Worker service meant for validating Serverless API Gateway (SAG) context
 * and environment variable propagation. It exposes a single `debug` handler that logs the
 * caller environment and SAG context, then returns them in the response for easy inspection.
 */
export default class extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
		this.logger = null;
  }

  /**
   * Generic fetch handler (optional). It can help verify the Worker is deployed correctly when
   * accessed directly via its sub-domain.
   */
  async fetch(request, env) {
    return new Response("Env-Test Service is running ✅", {
      headers: { "content-type": "text/plain;charset=UTF-8" }
    });
  }

  /**
   * debug()
   * Serverless API Gateway will invoke this function with the standard signature:
   *  - request:  Fetch Request object
   *  - caller_env:  Stringified environment object from the API gateway (service binding env)
   *  - sagContext:  Stringified SAG context containing auth data, path params, etc.
   *
   * The function logs both objects (at DEBUG level) and echoes them back in the response body.
   */
  async debug(request, caller_env = "{}", sagContext = "{}") {
    // Only key names are returned and nothing is logged: values carry the gateway's secrets.
    let keys = [];
    try {
      keys = Object.keys(JSON.parse(caller_env)).sort();
    } catch {
      keys = [];
    }
    return {
      statusCode: 200,
      message: "Environment key names",
      data: { callerEnvKeys: keys, timestamp: new Date().toISOString() }
    };
  }
} 
