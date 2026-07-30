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
          "Access-Control-Allow-Origin": "https://hrtalentalliance.com",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

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

        const formData = await request.json();

        console.log(formData);

        console.log("Getting access token...")
        const accessToken = await getValidAccessToken(env, userId);
        console.log(`Access token: ${accessToken}`)
        // console.log("Getting search results...")
        // const resSearchResult = await fetch("https://bb3api.topechelon.com/public/v1/quick_find/search?type=person&term=Cheryl", {
        //   method: "GET",
        //   headers: {
        //     "Authorization": `Bearer ${accessToken}`,
        //   }
        // })

        // console.log(`${resSearchResult.status}: ${resSearchResult.statusText}`)
        // const searchResult = await resSearchResult.json();
        // await env.TOKEN_KV.put(`res:Cheryl`, JSON.stringify(searchResult));
        console.log("Creating new person record...")
        const resCreatePerson = await fetch("https://bb3api.topechelon.com/public/v1/people", {
          method: "POST",
          headers: { 
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            "person": {
              "first_name": "Euan",
              "last_name": "Hird",
              "middle_initial": "j",
              "nick_name": "Euan",
              "status": "active",
              "suffix": "MEng",
              "street_address": "Oxford Street",
              "street_address_two": "string",
              "city": "London",
              "state": "",
              "zip": "W1D 1BS",
              "country": "United Kingdom",
            }
          })  
        })

        console.log(`Status: ${resCreatePerson.status} ${resCreatePerson.statusText}`)
        const personRecord = await resCreatePerson.json();
        console.log(`New person created with ID: ${personRecord["person"]["id"]}`)
        console.log(personRecord)
        await env.TOKEN_KV.put(`personRecord:${formData["fname"]}${formData["lname"]}`, JSON.stringify(personRecord));

        return new Response("Ok", { 
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "https://hrtalentalliance.com",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
         });
      
      default:
        return new Response("Page not found", { status: 400 })
    }
  }
};