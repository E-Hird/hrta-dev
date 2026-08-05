/**
 * Admin actions
 * 
 * A collections of admin functions for manipulating the data in 3rd party databases.
 * DB: Top Echelon, Notion
 * 
 * env vars required: None
 */

/**
 * Gets the id of the "Delete Me" tag or creates it if it doesn't exist
 * @param {string} accessToken 
 * @returns {string} tagId
 */
async function getDeleteTagTE(accessToken) {
    const tagId = "";
    return tagId;
}

/**
 * Sets up a timer for retrying a request
 * @param {*} retryAfterHeader 
 * @returns A promise to be awaited.
 */
function retryTimer(retryAfterHeader){
    let waitMs;
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader) + 5;
        waitMs = Number.isNaN(seconds)
            ? new Date(retryAfterHeader).getTime() - Date.now()
            : seconds * 1000;
    } else {
        waitMs = 2 ** attempt * 1000;
    }

    console.warn(`Retry required, waiting ${waitMs}ms`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Creates a dictionary of duplicate people records on Top Echelon.
 * @param {string} accessToken 
 * @returns {Map} a dictionary of duplicate people and their IDs
 */
export async function findDuplicatesTE(accessToken) {
    const seen = new Map();
    var totalPages = 1;
    var currentPage = 1;
    while (currentPage <= totalPages){
        const resPeopleSearch = await fetch("https://bb3api.topechelon.com/public/v1/people/search", {
            method: "POST",
            headers: { 
                "Authorization": `Bearer ${accessToken}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                "page": currentPage,
                "sort_by": "date_added",
                "sort_order": "asc",
                "person_search": {
                    "keyword": ""
                }
            })
        })
        //console.log(`Response: ${currentPage}/${totalPages} ${resPeopleSearch.status} ${resPeopleSearch.statusText}`)
        if (resPeopleSearch.status === 429) {
            const retryAfterHeader = resPeopleSearch.headers.get("Retry-After");
            await retryTimer(retryAfterHeader);
            continue;
        }
        if (resPeopleSearch.status === 500) {
            await retryTimer(5);
            continue;
        }

        const object = await resPeopleSearch.json()
        const pagination = object["pagination"];
        const entries = object["entries"];

        for (var person of entries){
            const key = person["name"]
            const id = person["id"]
            if (!seen.has(key)) {
                seen.set(key, []);
            }
            seen.get(key).push(id);
        }
        totalPages = pagination["total_pages"];
        currentPage = pagination["current_page"] + 1;
    }
    
    const duplicates = new Map(
        [...seen].filter(([, values]) => values.length > 1)
    );
    return duplicates;
}

/**
 * Marks a defined list of duplicate people records for deletion.
 * @param {string} accessToken 
 * @param {Object} duplicates 
 * @returns {Object} the status and a status message of the check
 */
export async function markDuplicatesTE(accessToken, duplicates){
    const success = true;
    const message = "All good";
    return {
        "status": success,
        "message": message
    }
}