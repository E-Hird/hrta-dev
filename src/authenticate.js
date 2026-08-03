/**
 * Authentication
 * 
 * A collection of utility functions for managing authentication tokens.
 * Creates, maintains and provides authentication tokens for Top Echelon.
 * 
 * env vars required: TOKEN_KV, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI
 */


/**
 * Checks if a token has expired.
 * @param {Object} tokens - JSON body containing the tokens
 * @returns {Boolean} true is token is expired, false otherwise
 */
function isExpired(tokens){
    // Measure time in seconds
    const time = Date.now() / 1000;
    if ((time - tokens["created_at"]) > tokens["expires_in"]){
        return true;
    } else {
        return false;
    }
}

/**
 * Use the refresh token to get new valid tokens.
 * @param {Object} env 
 * @param {Object} tokens 
 * @param {string} userId 
 * @returns {Object} JSON body of new tokens
 */
async function updateToken(env, tokens, userId){
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
    return newTokens;
}

/**
 * Deliver a valid authentication token to the worker.
 * @param {Object} env
 * @param {string} userId 
 * @returns {string} A valid access token
 */
export async function getAccessTokenTE(env, userId) {
  const tokens = await env.TOKEN_KV.get(`tokens:${userId}`, "json")

  if (isExpired(tokens)) {
    console.log("Token is expired")
    const newTokens = await updateToken(env, tokens, userId)
    // Store new token locally
    await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens));
    return newTokens.access_token;
  }

  return tokens.access_token;
}

/**
 * Get a new authentication token via authorization code.
 * @param {Object} env 
 * @param {string} code 
 * @param {string} userId 
 * @returns {status} The status of the fetch response
 */
export async function newAccessToken(env, code, userId) {
    const resAuthToken = await fetch("https://bb3api.topechelon.com/top_echelon_provider/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code,
            client_id: env.CLIENT_ID,
            client_secret: env.CLIENT_SECRET,
            redirect_uri: env.REDIRECT_URI,
        }),
    })
    const newTokens = await resAuthToken.json();
    await env.TOKEN_KV.put(`tokens:${userId}`, JSON.stringify(newTokens))
    return resAuthToken.status
}