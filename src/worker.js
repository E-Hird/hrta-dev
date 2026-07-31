function isExpired(tokens){
  const time = Date.now() / 1000;
  if ((time - tokens["created_at"]) > tokens["expires_in"]){
    return true;
  } else {
    return false;
  }
}

async function getValidAccessToken(env, userId) {
  const tokens = await env.TOKEN_KV.get(`tokens:${userId}`, "json")

  if (isExpired(tokens)) {
    console.log("Token is expired")
    const resAuthToken = await fetch("https://bb3api.topechelon.com/top_echelon_provider/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        redirect_uri: env.REDIRECT_URI,
      }),
    });
    const newTokens = await resAuthToken.json();
    await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens));
    return newTokens.access_token;
  }

  return tokens.access_token;
}


export default {
	async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userId = env.USER_ID

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "https://www.hrtalentalliance.com",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      switch (url.pathname){
        case "/topechelon/callback":
          const tokenCode = url.searchParams.get("code");
          const resAuthToken = await fetch("https://bb3api.topechelon.com/top_echelon_provider/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: tokenCode,
              client_id: env.CLIENT_ID,
              client_secret: env.CLIENT_SECRET,
              redirect_uri: env.REDIRECT_URI,
            }),
          })
          const newTokens = await resAuthToken.json();
          await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens))
          return new Response(`Response: ${resAuthToken.status}`, { status: resAuthToken.status })

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
          const resumeFile = formData.get("resume")
          const data = Object.fromEntries(formData)
          console.log(data);
          console.log(resumeFile instanceof Blob, resumeFile.size, resumeFile.type, resumeFile.name);
          const fileDeliver = new FormData();
          fileDeliver.append("file", resumeFile, resumeFile.name)

          console.log("Getting access token...")
          const accessToken = await getValidAccessToken(env, userId);
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

          console.log(`Status: ${resCreatePerson.status} ${resCreatePerson.statusText}\nText: ${resCreatePerson.text()}`)
          const personRecord = await resCreatePerson.json();
          console.log(`New person created with ID: ${personRecord["person"]["id"]}`)
          console.log(personRecord)

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