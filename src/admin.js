/**
 * Admin actions
 * 
 * A collections of admin functions for manipulating the data in 3rd party databases.
 * DB: Top Echelon, Notion
 * 
 * env vars required: None
 */

/**
 * Gets the id of the `Delete` Hotlist or creates it if it doesn't exist
 * @param {string} accessToken 
 * @returns {string} tagId
 */
async function getDeleteListTE(accessToken) {
    const tagId = "";
    const resDeleteHotlist = await fetch("https://bb3api.topechelon.com/public/v1/hotlists?record_type=person&scope=my&name=Delete&page=1", {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${accessToken}`
        }
    })
    return tagId;
}

/**
 * Sets up a timer for retrying a request
 * @param {*} retryAfterHeader 
 * @returns A promise to be awaited.
 */
function retryTimer(retryAfterHeader){
    let waitMs;
    // Generate timer
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader) + 5;
        waitMs = Number.isNaN(seconds)
            ? new Date(retryAfterHeader).getTime() - Date.now()
            : seconds * 1000;
    } else {
        waitMs = 2 ** attempt * 1000;
    }

    // If timer is too long return false (generate an error)
    if (waitMS > 120000){
        return false
    }

    console.warn(`Retry required, waiting ${waitMs}ms`);
    return new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Creates a dictionary of duplicate people records on Top Echelon.
 * @param {string} accessToken 
 * @returns {Object} status object containing a `"duplicates"` field on success
 */
export async function findDuplicatesTE(accessToken) {
    const seen = new Map();
    var totalPages = 1;
    var currentPage = 1;
    var retries = 0;
    // Iterate over each paginated page of results to collect all records
    while (currentPage <= totalPages){
        // After 3 retries throw an error
        if (retries > 3){
            console.error("Too many retries")
            return false
        }
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
        // Handle response errors
        if (resPeopleSearch.status === 429) {
            retries += 1;
            const retryAfterHeader = resPeopleSearch.headers.get("Retry-After");
            const timer = retryTimer(retryAfterHeader);
            // If timer is created return
            if (timer) {
                await timer;
            } else {
                console.error("Retry timer broken or too long.")
                return {
                    "status": 429,
                    "message": "Retry timer broken or too long"
                }
            }
            continue;
        } else if (resPeopleSearch.status === 401) {
            console.error("Authentication error")
            return {
                "status": 401,
                "message": "Authentication error"
            }
        } else if (resPeopleSearch.status != 200) {
            // By default retry after 5 seconds
            retries += 1
            await retryTimer(5);
            continue;
        }

        const object = await resPeopleSearch.json()
        const pagination = object["pagination"];
        const entries = object["entries"];

        for (var person of entries){
            const key = person["name"]
            const id = person["id"]
            // Create a new key if the name hasn't been seen before
            if (!seen.has(key)) {
                seen.set(key, []);
            }
            seen.get(key).push(id);
        }
        // Move onto the next page
        totalPages = pagination["total_pages"];
        currentPage = pagination["current_page"] + 1;
        retries = 0
    }
    
    // Filter for keys with more than one ID
    const duplicates = new Map(
        [...seen].filter(([, values]) => values.length > 1)
    );
    return {
        "status": 200,
        "message": "Success",
        "duplicates": duplicates
    };
}

/**
 * Marks a defined list of people records for deletion.
 * @param {string} accessToken 
 * @param {Object} records
 * @returns {Object} the status and a status message of the check
 */
export async function markDuplicatesTE(accessToken, records){
    // Check that the delete hotlist exists

    const message = "All good";
    return {
        "status": 200,
        "message": message
    }
}