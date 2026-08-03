/**
 * Worker Entry Point
 * 
 * Receives requests from clients and routes them to the correct function.
 * 
 * Env vars required: USER_ID
 */

import {getAccessTokenTE, newAccessToken} from "./authenticate.js";

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
          resStatus = await newAccessToken(env, tokenCode, userId)
          return new Response(`Response: ${resAuthToken.status}`, { status: resAuthToken.status })

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
          const data = Object.fromEntries(formData)
          console.log(data);

          console.log("Getting access token...")
          const accessToken = await getAccessTokenTE(env, userId);
          console.log(`Access token: ${accessToken}`)
          console.log("Creating new person record from resume...")
          const resCreatePerson = await fetch("https://bb3api.topechelon.com/public/v1/people", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              "person": {
                "first_name": formData.get("fname"),
                "last_name": formData.get("lname"),
                "status": "active"
              }
            })
          })

          const personRecord = await resCreatePerson.json();
          console.log(`Status: ${resCreatePerson.status} ${resCreatePerson.statusText}\nText: ${personRecord}`)
          console.log(`New person created with ID: ${personRecord["person"]["id"]}`)
          console.log(personRecord)

          const resumeFile = formData.get("resume")
          console.log(resumeFile instanceof Blob, resumeFile.size, resumeFile.type, resumeFile.name);
          const fileDeliver = new FormData();
          fileDeliver.append("file", resumeFile, resumeFile.name)

          const resParseResume = await fetch("https://bb3api.topechelon.com/public/v1/people/parse", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
            },
            body: fileDeliver
          })

          if (!resCreatePerson.ok) {
            console.log(resCreatePerson)
          }

          console.log(`Status: ${resParseResume.status} ${resParseResume.statusText}`)
          console.log("Resume parsed")
          await env.TOKEN_KV.put(`personRecord:${data["fname"]}${data["lname"]}`, JSON.stringify(personRecord));

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