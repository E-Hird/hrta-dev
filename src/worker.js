/**
 * Worker Entry Point
 * 
 * Receives requests from clients and routes them to the correct function.
 * 
 * Env vars required: USER_ID
 */

import { findDuplicatesTE } from "./admin.js";
import { addToHotlistTE, getTrackedDatabasesN, trackNewDatabaseN, getDatabaseIdN, getFilteredRecordsN } from "./database-actions.js"
import { getAccessTokenTE, newAccessTokenTE, getAccessTokenN, updateAccessTokenN } from "./authenticate.js";
import { fractionalSubmission } from "./form.js";

export default {
	async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userId = env.USER_ID;
    const origin = request.headers.get("Origin");

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
          const resStatus = await newAccessTokenTE(env, tokenCode, userId)
          return new Response(`Response: ${resStatus}`, { status: resStatus })

        /**
         * Responses:
         * - 200: access token refreshed successfully
         */
        case "/refresh-token-te":
          var accessTokenTE = await getAccessTokenTE(env, userId);
          return new Response("Token refreshed, check KV", { status: 200 })

        /**
         * Responses:
         * - 200: access token updated successfully
         * - 400: new token is invalid
         * - 403: incorrect origin used (not from website)
         * - 405: incorrect method used
         */
        case "/update-token-n":
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          const newToken = await request.text();
          if (!newToken.startsWith("ntn_")) {
            return new Response("Invalid token detected", { status: 400 })
          }

          updateAccessTokenN(env, userId, newToken)
          return new Response("PAT updates successfully.", { status: 200 })

        /**
         * Responses:
         * - 200: submission accepted and forwarded
         * - 400: error submission was malformed
         * - 403: incorrect origin used (not from website)
         * - 405: incorrect method used
         * - 500: repeated error(s) submitting form
         */
        case "/fractional":
          console.log("Got fractional request.")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

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
            var accessTokenTE = await getAccessTokenTE(env, userId);
            // Attempt to submit the fractional form
            const createPerson = await fractionalSubmission(accessTokenTE, formData);
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
        
        /**
         * Responses:
         * - 200: the dictionary of people with duplicate records
         * - 403: incorrect origin used (not from website)
         * - 405: incorrect method used
         */
        case "/admin/duplicates":
          console.log("Got admin request: Identify duplicates")
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          var accessTokenTE = await getAccessTokenTE(env, userId);
          const duplicates = await findDuplicatesTE(accessTokenTE);
          // Handle errors
          if (duplicates["status"] !== 200){
            console.error(`Error ${duplicates["status"]}: ${duplicates["message"]}`)
            return new Response("Server Error", {
              status: 500,
              headers: {
                "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
              },
            })
          }

          // On success return the map as a json object
          return new Response(JSON.stringify(Object.fromEntries(duplicates["duplicates"])), {
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          })
          break;

        /**
         * Responses:
         * - 200: records added to delete hotlist successfully
         * - 403: incorrect origin used (not from website)
         * - 405: incorrect method used
         * - 500: error when attempting to add to hotlist 
         */
        case "/admin/delete":
          console.log("Got admin request: Mark for deletion")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          const records = await request.json()
          console.log(records)

          var accessTokenTE = await getAccessTokenTE(env, userId);
          const resHotlist = await addToHotlistTE(accessTokenTE, "delete", records);

          if (resHotlist["status"] !== 200){
            console.error(`Error adding records to hotlist: ${resHotlist["message"]}`)
            return new Response("Server Error please try again later...", {
              status: 500,
              headers: {
                "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
              },
            })
          }

          return new Response("Records added to hotlist.", { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          });

        /**
         * Responses:
         * - 200: list of databases delivered successfully
         */
        case "/get-tracked-databases":
          const databaseList = await getTrackedDatabasesN(env)
          const names = databaseList.map(obj => obj["name"])

          return new Response(JSON.stringify(names), { status: 200 })

        /**
         * Responses:
         * - 200: database now being tracked
         * - 400: invalid input
         * - 403: invalid method
         * - 500: error while attempting to track database
         */
        case "/track-new-database":
          console.log("Got request to track a new database.")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          var input = await request.json();
          if (!(input["name"] && input["link"])){
            return new Response("Malformed input", { status: 400 })
          }
          if (!input[link].startsWith("https://app.notion.com/")) {
            return new Response("Must include share link", { status: 400 })
          }

          // Get the path of the share link
          var matchId = input["link"].split("?")[0]
          // Get the ID from the path
          matchId = matchId.split["/"].at(-1)

          var accessTokenN = getAccessTokenN(env, userId)
          const newTrack = trackNewDatabaseN(accessTokenN, env, input["name"], matchId)

          if (!newTrack) {
            return new Response("Error tracking database", { status: 500 })
          }

          return new Response("Database tracked", { status: 200 })
        
        
        case "/get-urgent-actions":
          console.log("Got request to query a database")  
          // if (request.method !== "POST") {
          //   return new Response("Method not allowed", { status: 405 });
          // }

          //var input = await request.json();

          var databaseId = await getDatabaseIdN(env, "fractionalTest")//input["database"])
          var filter = {
            "property": "Stage",
            "multi_select": {
              "contains": "Follow up needed"
            }
          }
          var sorts = [{
            "property": "Email",
            "direction": "ascending",
          }]

          var accessTokenN = await getAccessTokenN(env, userId)
          console.log(accessTokenN)
          var data = await getFilteredRecordsN(accessTokenN, databaseId, filter, sorts)
          var results = data["results"]
          const actions = []

          for (var result of results){
            actions.push(result["properties"]["Name (x if no intake form)"]["title"][0]["plain_text"])
          }
          return new Response(JSON.stringify(actions), { status: 200 })

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