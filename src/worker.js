/**
 * Worker Entry Point
 * 
 * Receives requests from clients and routes them to the correct function.
 * 
 * Env vars required: USER_ID
 */

import { getAccessTokenTE, newAccessToken } from "./authenticate.js";
import { fractionalSubmission } from "./form.js";

export default {
	async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userId = env.USER_ID

    // Handle CORS for preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Route incoming requests
    try {
      switch (url.pathname){
        /**
         * Responses:
         * - 200: access token created successfully
         */
        case "/topechelon/callback":
          const tokenCode = url.searchParams.get("code");
          const resStatus = await newAccessToken(env, tokenCode, userId)
          return new Response(`Response: ${resStatus}`, { status: resStatus })

        /**
         * Responses:
         * - 200: submission accepted and forwarded
         */
        case "/fractional":
          console.log("Got fractional request.")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          const origin = request.headers.get("Origin");
          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          const formData = await request.formData();

          const accessToken = await getAccessTokenTE(env, userId);
          console.log(`Access token: ${accessToken}`)

          console.log("Creating a new person record")
          const createPerson = fractionalSubmission(accessToken, formData);

          console.log(`New person created, status: ${createPerson["status"]}`)

          return new Response("Ok", { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });
        
        default:
          return new Response("Page not found", { status: 400 })
      }
    } catch (error) {
      console.error(`Server Error: ${error}`)
      // On error send 5xx to client, handle CORS
      /**
       * Responses:
       * - 500: general server error
       */
      return new Response("Server Error", {
        status: 500,
        headers: {
          "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      })
    }
  }
};