async function getValidAccessToken(env, userId) {
  const tokens = await env.TOKEN_KV.get(`tokens:${userId}`, "json")

  if (isExpired(tokens)) {
    const res = await fetch("https://bb3api.topechelon.com/top_echelon_provider/oauth/token", {
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
    const newTokens = await res.json();
    await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens));
    return newTokens.access_token;
  }

  return tokens.access_token;
}


export default {
	async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userId = env.USER_ID

    switch (url.pathname){
      case "/topechelon/callback":
        const tokenCode = url.searchParams.get("code");
        const res = await fetch("https://bb3api.topechelon.com/top_echelon_provider/oauth/token", {
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
        const newTokens = await res.json();
        await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens))
        return new Response("Response", { status: res.status })

      case "/fractional":
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }

        const origin = request.headers.get("Origin");
        if (origin !== "https://www.hrtalentalliance.com") {
          return new Response("Forbidden", { status : 403 });
        }

        const formData = await request.json();

        console.log(formData);

        return new Response("Ok", { status: 200 });
      
      default:
        return new Response("Page not found", { status: 400 })
    }
  }
};