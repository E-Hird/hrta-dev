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
         * - 200: access token refreshed successfully
         */
        case "/refresh-token":
          const accessToken = await getAccessTokenTE(env, userId);
          console.log(`Access token: ${accessToken}`)
          return new Response("Token refreshed, check KV", { status: 200 })

        /**
         * Responses:
         * - 200: submission accepted and forwarded
         * - 400: error submission was malformed
         * - 405: incorrect method used
         * - 403: incorrect origin used (not from website)
         * - 500: repeated error(s) submitting form
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

          var submitted = false;
          var retries = 0;
          while (!submitted){
            // Return a server failure if submission hasn't succeeded after 3 tries
            if (retries > 3){
              return new Response("Repeated error(s) when submitting", { 
                status: 500,
                headers: {
                  "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
              });
            }

            // Get the access token for Top Echelon
            const accessToken = await getAccessTokenTE(env, userId);
            // Attempt to submit the fractional form
            const createPerson = await fractionalSubmission(accessToken, formData);
            // Handle results of form submission
            const submissionID = createPerson["id"]
            switch (createPerson["status"]){
              case 200: // Success
                console.log(`Submission successful: ${submissionID}`)
                return new Response("Form submitted successfully.", { 
                  status: 200,
                  headers: {
                    "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                  },
                });

              case 400: // Malformed input
                console.error(`${submissionID}: Error - malformed input (${createPerson["message"]})`)
                return new Response(createPerson["message"], { 
                  status: 400,
                  headers: {
                    "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                  },
                });

              case 403: // Top Echelon account failure
              case 500: // Top Echelon server error
                // Abort
                console.error(`${submissionID}: Top Echelon Server error (${createPerson["message"]}), aborting...`)
                return new Response(createPerson["message"], { 
                  status: 500,
                  headers: {
                    "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                  },
                });

              case 401: // Authentication failure
              case 404: // Not found
              case 422: // Request unacceptable
              case 429: // Too many requests
              default:
                console.warn(`${submissionID}: Minor error encountered (${createPerson["message"]}), retrying...`)
                // Retry
                continue;
            }
          }
          break; 
        
        default:
          return new Response("Page not found", { status: 404 })
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