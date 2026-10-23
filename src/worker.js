/**
 * Worker Entry Point
 * 
 * Receives requests from clients and routes them to the correct function.
 * 
 * Env vars required: USER_ID
 */

import { findDuplicatesTE } from "./admin.js";
import { addToHotlistTE, getTrackedDatabasesN, trackNewDatabaseN, getDatabaseIdN, getFilteredRecordsN, getDatabaseSchemaN, uploadFileN, addRecordN, updateRecordN, getHotlistRecordsTE, getJobTE, addRecordTE, getFilteredRecordsTE, updateRecordTE } from "./database-actions.js"
import { getAccessTokenTE, newAccessTokenTE, getAccessTokenN, updateAccessTokenN } from "./authenticate.js";
import { fractionalSubmission, advisorySubmission } from "./form.js";

// ================================================ Helpers for the Top Echelon record endpoints ================================================

/**
 * Hotlist names are sent to Top Echelon in a query string without encoding (see `getHotlistIdTE`),
 * so these characters would make the search find the wrong hotlist.
 */
const UNSAFE_HOTLIST_CHARS = /[&#%+?]/;

/** Record ids end up in a URL path, so only allow plain id characters */
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Checks a value is a plain object (not null, not an array)
 * @param {*} value 
 * @returns {Boolean}
 */
function isPlainObject(value){
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Reads a request body as a JSON object.
 * @param {Request} request 
 * @returns {Object|null} the parsed object, or `null` if the body isn't a JSON object
 */
async function readJsonObject(request){
  try {
    const body = await request.json()
    return isPlainObject(body) ? body : null
  } catch {
    return null
  }
}

/**
 * Validates the optional `hotlist` field of a request. `undefined`, `null` and `""` all mean "no hotlist".
 * @param {*} hotlist 
 * @returns {string|null} an error message, or `null` if the field is absent or valid
 */
function checkHotlistField(hotlist){
  if (hotlist === undefined || hotlist === null || hotlist === "") return null
  if (typeof hotlist !== "string" || !hotlist.trim()) return "Hotlist must be a non-empty string"
  if (UNSAFE_HOTLIST_CHARS.test(hotlist)) return "Hotlist name can't contain & # % + or ?"
  return null
}

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
          var tokenCode = url.searchParams.get("code");
          var resStatus = await newAccessTokenTE(env, tokenCode, userId)
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

          var newToken = await request.text();
          if (!newToken.startsWith("ntn_")) {
            return new Response("Invalid token detected", { status: 400 })
          }

          await updateAccessTokenN(env, userId, newToken)
          return new Response("PAT updates successfully.", { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          })

        /**
         * Responses:
         * - 200: job list returned successfully
         * - 403: invalid origin (not website)
         * - 405: invalid method
         * - 500: error trying to get the job list
         */
        case "/get-jobs":
          console.log("Got job board request")
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          var accessTokenTE = await getAccessTokenTE(env, userId);
          var resJobList = await getHotlistRecordsTE(accessTokenTE, "Job Board", "job")
          if (resJobList["status"] !== 200){
            return new Response(resJobList["message"], { 
              status: 500, 
              headers: {
                  "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
            })
          }
          var jobList = resJobList["results"]
          if (!jobList){
            return new Response("Job list not found", { status: 500 })
          }

          var fullJobs = []
          for (let job of jobList){
            fullJobs.push((await getJobTE(accessTokenTE, job["id"]))["job"])
          }

          return new Response(JSON.stringify(fullJobs), { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          })

        
        
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

          var formData = await request.formData();

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
            var createPerson = await fractionalSubmission(accessTokenTE, formData);
            // Handle results of form submission
            var submissionID = createPerson["id"]
            retries += 1
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
         * - 200: submission accepted and forwarded
         * - 400: error submission was malformed
         * - 403: incorrect origin used (not from website)
         * - 405: incorrect method used
         * - 500: repeated error(s) submitting form
         */
        case "/advisory":
          console.log("Got advisory request.")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (origin !== "https://www.hrtalentalliance.com") {
            return new Response("Forbidden", { status : 403 });
          }

          var formData = await request.formData();

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
            // Attempt to submit the advisory form
            var createPerson = await advisorySubmission(accessTokenTE, formData);
            // Handle results of form submission
            var submissionID = createPerson["id"]
            retries += 1
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
          var duplicates = await findDuplicatesTE(accessTokenTE);
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

          var records = await request.json()
          console.log(records)

          var accessTokenTE = await getAccessTokenTE(env, userId);
          var resHotlist = await addToHotlistTE(accessTokenTE, "delete", records);

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
          var databaseList = await getTrackedDatabasesN(env)
          var names = databaseList.map(obj => obj["name"])

          return new Response(JSON.stringify(names), { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
          })

        /**
         * Responses:
         * - 200: database now being tracked
         * - 400: invalid input
         * - 405: invalid method
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
          if (!input["link"].startsWith("https://app.notion.com/")) {
            return new Response("Must include share link", { status: 400 })
          }

          // Get the path of the share link
          var matchId = input["link"].split("?")[0]
          // Get the ID from the path
          matchId = matchId.split("/").at(-1)

          var accessTokenN = await getAccessTokenN(env, userId)
          var newTrack = await trackNewDatabaseN(accessTokenN, env, input["name"], matchId)

          if (!newTrack) {
            return new Response("Error tracking database", { 
              status: 500,
              headers: {
                "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
              }, 
            })
          }

          return new Response("Database tracked", { 
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
              "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
          })
        
        /**
         * Responses:
         * - 200: query results returned
         * - 400: invalid input
         * - 404: database not found
         * - 405: invalid method
         * - 500: error while
         */
        case "/query-notion":
          console.log("Got request to query a database")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await request.json();

          // Check the input has the correct fields
          if (!input["database"]){
            return new Response("Database not specified", { status: 400 })
          }
          if (!input["filter"]){
            return new Response("Filter not specified", { status: 400 })
          }
          if (!input["sort"]){
            return new Response("Sort order not specified", { status: 400 })
          }

          // Check the database is being tracked
          var databaseId = await getDatabaseIdN(env, input["database"])
          if (!databaseId) {
            return new Response("Database not found", { status: 404 })
          }
          var filter = input["filter"]
          var sorts = input["sort"]

          // Query the database
          var accessTokenN = await getAccessTokenN(env, userId)
          var data = await getFilteredRecordsN(accessTokenN, databaseId, filter, sorts)
          if (data["status"] !== 200){
            return new Response(data["message"], { status: 500 })
          }
          var results = data["results"]

          return new Response(JSON.stringify(results), { status: 200 })

        /**
         * Responses:
         * - 200: schema returned
         * - 400: invalid input
         * - 404: database not being tracked
         * - 405: invalid method
         * - 500: error getting database schema
         */
        case "/get-schema":
          console.log("Got request for the schema of a database")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await request.json();
          // Check the input has the correct fields
          if (!input["database"]){
            return new Response("Database not specified", { status: 400 })
          }

          // Check the database is being tracked
          var databaseId = await getDatabaseIdN(env, input["database"])
          if (!databaseId) {
            return new Response("Database not found", { status: 404 })
          }

          // Get the database schema
          var accessTokenN = await getAccessTokenN(env, userId)
          var resSchema = await getDatabaseSchemaN(accessTokenN, databaseId)
          if (resSchema["status"] !== 200){
            return new Response(resSchema["message"], { status: 500 })
          }
          var schema = resSchema["schema"]

          return new Response(JSON.stringify(schema), { status: 200 })

        /**
         * Responses:
         * - 200: File uploaded successfully
         * - 400: invalid input
         * - 405: invalid method
         * - 500: error when uploading file
         */
        case "/upload-file-notion":
          console.log("Got request to upload a file to notion database")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await request.json();
          // Check the input has the correct fields
          if (!input["method"]){
            return new Response("Upload method missing", { status: 400 })
          }
          if (!input["file"]){
            return new Response("File missing", { status: 400 })
          }
          if (!input["filename"]){
            return new Response("Filename missing", { status: 400 })
          }

          // Upload file to get file id
          var accessTokenN = await getAccessTokenN(env, userId)
          var resUpload = await uploadFileN(accessTokenN, input["file"], input["filename"], input["method"])
          if (resUpload["status"] !== 200){
            return new Response(resUpload["message"], { status: 500 })
          }
          var uploadId = resUpload["id"]

          return new Response(uploadId, { status: 200 })

        /**
         * Responses:
         * - 200: record added successfully
         * - 400: invalid input
         * - 404: database not found
         * - 405: invalid  method
         * - 500: error when adding record to database
         */
        case "/add-record-notion":
          console.log("Got request to add a record to notion database")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await request.json();
          // Check the input has the correct fields
          if (!input["database"]){
            return new Response("Database not specified", { status: 400 })
          }
          if (!input["properties"]){
            return new Response("Record properties missing", { status: 400 })
          }

          // Check the database is being tracked
          var databaseId = await getDatabaseIdN(env, input["database"])
          if (!databaseId) {
            return new Response("Database not found", { status: 404 })
          }

          // Get the database schema
          var accessTokenN = await getAccessTokenN(env, userId)
          var resAddRecord = await addRecordN(accessTokenN, databaseId, input["properties"])
          if (resAddRecord["status"] !== 200){
            return new Response(resAddRecord["message"], { status: 500 })
          }

          return new Response("Record Added Successfully", { status: 200 })

        /**
         * Responses:
         * - 200: record updated successfully
         * - 400: invalid input
         * - 405: invalid  method
         * - 500: error when updating record
         */
        case "/update-record-notion":
          console.log("Got request to update a record in notion database")  
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await request.json();
          // Check the input has the correct fields
          if (!input["record"]){
            return new Response("Record not specified", { status: 400 })
          }
          if (!input["properties"]){
            return new Response("Update properties missing", { status: 400 })
          }

          // Get the database schema
          var accessTokenN = await getAccessTokenN(env, userId)
          var resUpdateRecord = await updateRecordN(accessTokenN, input["record"], input["properties"])
          if (resUpdateRecord["status"] !== 200){
            return new Response(resUpdateRecord["message"], { status: 500 })
          }

          return new Response("Record Updated Successfully", { status: 200 })

        // ================================================== Top Echelon records ==================================================

        /**
         * Queries Top Echelon person records (mirrors /query-notion).
         * Input: { "filter": <person_search object>, "sort_by": optional, "sort_order": optional "asc" | "desc" }
         * Responses:
         * - 200: JSON array of the matching person records (empty if none match).
         *        Header `X-Results-Truncated: true` is added if the page limit cut the results short.
         * - 400: invalid input
         * - 405: invalid method
         * - 500: error while querying Top Echelon
         */
        case "/query-te":
          console.log("Got request to query Top Echelon")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await readJsonObject(request);
          if (!input) {
            return new Response("Body must be a JSON object", { status: 400 })
          }

          // Check the input has the correct fields
          if (!input["filter"]){
            return new Response("Filter not specified", { status: 400 })
          }
          if (!isPlainObject(input["filter"])){
            return new Response("Filter must be an object", { status: 400 })
          }
          var sortBy = input["sort_by"]
          var sortOrder = input["sort_order"]
          if (sortBy !== undefined && (typeof sortBy !== "string" || !sortBy)){
            return new Response("sort_by must be a non-empty string", { status: 400 })
          }
          if (sortOrder !== undefined && !["asc", "desc"].includes(sortOrder)){
            return new Response("sort_order must be 'asc' or 'desc'", { status: 400 })
          }

          // Query Top Echelon (an undefined sort falls back to the default of newest first)
          var accessTokenTE = await getAccessTokenTE(env, userId)
          var resQueryTE = await getFilteredRecordsTE(accessTokenTE, input["filter"], sortBy, sortOrder)
          if (resQueryTE["status"] !== 200){
            return new Response(resQueryTE["message"], { status: 500 })
          }

          return new Response(JSON.stringify(resQueryTE["results"]), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...(resQueryTE["truncated"] ? { "X-Results-Truncated": "true" } : {}),
            },
          })

        /**
         * Adds a person record to Top Echelon (mirrors /add-record-notion), optionally into a hotlist.
         * Input: { "properties": <person object>, "hotlist": optional hotlist name }
         * Responses:
         * - 200: record added. JSON { message, id } (plus `hotlist` if it was added to one)
         * - 400: invalid input
         * - 405: invalid method
         * - 500: error when adding the record, or the record was added but the hotlist step failed
         */
        case "/add-record-te":
          console.log("Got request to add a record to Top Echelon")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await readJsonObject(request);
          if (!input) {
            return new Response("Body must be a JSON object", { status: 400 })
          }

          // Check the input has the correct fields
          if (!input["properties"]){
            return new Response("Record properties missing", { status: 400 })
          }
          if (!isPlainObject(input["properties"])){
            return new Response("Record properties must be an object", { status: 400 })
          }
          var hotlistErrorAdd = checkHotlistField(input["hotlist"])
          if (hotlistErrorAdd){
            return new Response(hotlistErrorAdd, { status: 400 })
          }

          // Create the record
          var accessTokenTE = await getAccessTokenTE(env, userId)
          var resAddRecordTE = await addRecordTE(accessTokenTE, input["properties"])
          if (resAddRecordTE["status"] !== 200){
            return new Response(resAddRecordTE["message"], { status: 500 })
          }
          var newRecordId = resAddRecordTE["id"]

          // Optionally add the new record to a hotlist
          if (input["hotlist"]){
            var resHotlistAdd = await addToHotlistTE(accessTokenTE, input["hotlist"], [newRecordId])
            if (resHotlistAdd["status"] !== 200){
              // The record exists by now, so report its id (retrying the request would create a duplicate)
              return new Response(`Record added (id: ${newRecordId}) but could not be added to hotlist: ${resHotlistAdd["message"]}`, { status: 500 })
            }
          }

          return new Response(JSON.stringify({
            "message": "Record Added Successfully",
            "id": newRecordId,
            ...(input["hotlist"] ? { "hotlist": input["hotlist"] } : {}),
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })

        /**
         * Updates a person record in Top Echelon (mirrors /update-record-notion), optionally adding it to a hotlist.
         * Input: { "record": <person id>, "properties": <person object>, "hotlist": optional hotlist name }
         * Responses:
         * - 200: record updated. JSON { message, id } (plus `hotlist` if it was added to one)
         * - 400: invalid input
         * - 405: invalid method
         * - 500: error when updating the record, or the record was updated but the hotlist step failed
         */
        case "/update-record-te":
          console.log("Got request to update a record in Top Echelon")
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          var input = await readJsonObject(request);
          if (!input) {
            return new Response("Body must be a JSON object", { status: 400 })
          }

          // Check the input has the correct fields
          if (!input["record"]){
            return new Response("Record not specified", { status: 400 })
          }
          var recordIdTE = String(input["record"])
          if (!RECORD_ID_PATTERN.test(recordIdTE)){
            return new Response("Record id is malformed", { status: 400 })
          }
          if (!input["properties"]){
            return new Response("Update properties missing", { status: 400 })
          }
          if (!isPlainObject(input["properties"])){
            return new Response("Update properties must be an object", { status: 400 })
          }
          var hotlistErrorUpdate = checkHotlistField(input["hotlist"])
          if (hotlistErrorUpdate){
            return new Response(hotlistErrorUpdate, { status: 400 })
          }

          // Update the record (this function returns the bare HTTP status)
          var accessTokenTE = await getAccessTokenTE(env, userId)
          var resUpdateRecordTE = await updateRecordTE(accessTokenTE, recordIdTE, input["properties"])
          if (resUpdateRecordTE !== 200){
            return new Response(`Failed to update record (Top Echelon responded ${resUpdateRecordTE})`, { status: 500 })
          }

          // Optionally add the record to a hotlist
          if (input["hotlist"]){
            var resHotlistUpdate = await addToHotlistTE(accessTokenTE, input["hotlist"], [recordIdTE])
            if (resHotlistUpdate["status"] !== 200){
              return new Response(`Record updated but could not be added to hotlist: ${resHotlistUpdate["message"]}`, { status: 500 })
            }
          }

          return new Response(JSON.stringify({
            "message": "Record Updated Successfully",
            "id": recordIdTE,
            ...(input["hotlist"] ? { "hotlist": input["hotlist"] } : {}),
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })

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